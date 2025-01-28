import { v4 as uuidv4 } from "uuid";
import { setTimeout } from "node:timers/promises";

import { createRegistrationToken, listIdleGitHubRunners } from "../github.js";
import { createKeyVaultSecret, createVM, deleteVM, deleteKeyVaultSecret, listAzureRunnerVMs } from "../azure/index.js";
import { getLogger } from "../logger.js";
import { getConfigValue } from "../azure/config.js";
import { getServiceBusClient, getServiceBusAdministrationClient } from "../azure/clients/service-bus.js";
import {
    addRunnerToState,
    getNumberOfRunnersFromState,
    getWarmPoolSizeByImage,
    removeRunnerFromState,
} from "./state.js";

let _runnerQueueSender,
    _runnerQueueReceiver,
    _stopRunnerProcessing = false;

const getQueueActiveMessageCount = async (queueConfigKey) => {
    const serviceBusAdminClient = await getServiceBusAdministrationClient();
    const queueName = await getConfigValue(queueConfigKey);

    const queueProperties = await serviceBusAdminClient.getQueueRuntimeProperties(queueName);

    return queueProperties.activeMessageCount;
};

const getRunnerQueueSender = async () => {
    if (!_runnerQueueSender) {
        const serviceBusClient = await getServiceBusClient();
        const queueName = await getConfigValue("azure-github-runners-queue");

        _runnerQueueSender = serviceBusClient.createSender(queueName);
    }

    return _runnerQueueSender;
};

const getRunnerQueueReceiver = async () => {
    if (!_runnerQueueReceiver) {
        const serviceBusClient = await getServiceBusClient();
        const queueName = await getConfigValue("azure-github-runners-queue");

        _runnerQueueReceiver = serviceBusClient.createReceiver(queueName, {
            receiveMode: "peekLock",
        });
    }

    return _runnerQueueReceiver;
};

export const processRunnerQueue = async () => {
    const logger = getLogger();
    const runnerMaxCount = Number(await getConfigValue("github-runner-maximum-count"));
    const receiver = await getRunnerQueueReceiver();

    logger.info("Runner queue process started");

    while (!_stopRunnerProcessing) { // eslint-disable-line no-unmodified-loop-condition
        const currentRunnerCount = getNumberOfRunnersFromState();

        if (currentRunnerCount >= runnerMaxCount) {
            await setTimeout(1000);
            continue;
        }

        // this will block the while loop for 60 seconds
        const [message] = await receiver.receiveMessages(1, {
            maxWaitTimeInMs: 60_000,
        });

        if (!message) {
            logger.debug("No message received");
        }

        if (_stopRunnerProcessing) {
            logger.warn("Went into stop processing condition");
            break;
        }

        if (!message) {
            logger.debug("No runners on queue");
            continue;
        }

        const { runnerName, imageConfig } = message.body;

        logger.info({ runnerName, imageId: imageConfig?.id }, "Received runner on queue");

        await createRunner(runnerName, imageConfig);
        await receiver.completeMessage(message);
    }
};

export const fillWarmPool = async () => {
    const logger = getLogger();
    const imageConfigs = JSON.parse(await getConfigValue("azure-gallery-images"));
    const currentWarmPoolSizes = getWarmPoolSizeByImage();
    const [runnerQueueSize, stateQueueSize] = await Promise.all([
        getQueueActiveMessageCount("azure-github-runners-queue"),
        getQueueActiveMessageCount("azure-github-state-queue"),
    ]);
    const activeQueueOffset = runnerQueueSize - stateQueueSize;

    logger.debug({
        "Image Configs": imageConfigs,
        "Current Warm Pool Sizes": Object.fromEntries(currentWarmPoolSizes),
        "Runner Queue Count": runnerQueueSize,
        "State Queue Size": stateQueueSize,
    });

    for (const imageConfig of imageConfigs) {
        const currentSize = currentWarmPoolSizes.get(imageConfig.id) || 0;
        const neededRunners = imageConfig.warm_pool_size - currentSize - activeQueueOffset;

        logger.debug({
            "Image ID": imageConfig.id,
            "Desired Size": imageConfig.warm_pool_size,
            "Current Size": currentSize,
            "Needed Runners": neededRunners,
        });

        for (let i = 0; i < neededRunners; i++) {
            const runnerName = await enqueueRunnerForCreation(imageConfig);
            logger.info({ runnerName, imageId: imageConfig.id }, "Enqueued runner to fill warm pool");
        }
    }
};

export const stopRunnerQueue = async () => {
    const logger = getLogger();
    const sender = await getRunnerQueueSender();
    const receiver = await getRunnerQueueReceiver();

    logger.info("Stopping runner queue process...");

    _stopRunnerProcessing = true;

    await sender.close;
    await receiver.close;
};

export const enqueueRunnerForCreation = async (imageConfig) => {
    const sender = await getRunnerQueueSender();
    const runnerName = `runner-${uuidv4().slice(0, 8)}`;

    await sender.sendMessages({
        body: { 
            runnerName,
            imageConfig
        },
        contentType: "application/json",
    });

    return runnerName;
};

const createRunner = async (runnerName, imageConfig) => {
    const logger = getLogger();
    const token = await createRegistrationToken();

    logger.debug("Received createRunner trigger with param", { runnerName, imageConfig });

    await createKeyVaultSecret(runnerName, token);
    await createVM(runnerName, imageConfig);

    addRunnerToState(runnerName, imageConfig);

    logger.info({ runnerName, imageId: imageConfig.id }, "Successfully created runner");
};

export const deleteRunner = (runnerName) => {
    const logger = getLogger();

    removeRunnerFromState(runnerName);

    Promise.all([
        deleteKeyVaultSecret(runnerName),
        deleteVM(runnerName),
    ]).then(() => {
        logger.info({ runnerName }, "Runner successfully deleted");
    }).catch((error) => {
        logger.error(error, "Error deleting runner");
    });
};

/* warm pool states
    github            azure         description
    online, idle   -  succeeded  -  obvious
    offline, idle  -  succeeded  -  gh runner config is finished registering, but gh does not see the runner online yet
    unregistered   -  creating   -  VM is being created, has not started custom data script
    unregistered   -  succeeded  -  Period of time between VM starting custom data script and registering as runner
*/
export const getInitialRunnerWarmPool = async () => {
    const [githubRunners, azureRunnerVMs] = await Promise.all([
        listIdleGitHubRunners(),
        listAzureRunnerVMs(),
    ]);

    return azureRunnerVMs
        .filter((vm) => {
            const githubRunner = githubRunners.find((runner) => runner.name === vm.name);
            return githubRunner || vm.provisioningState === "Succeeded" || vm.provisioningState === "Creating";
        })
        .map((vm) => vm.name);
};
