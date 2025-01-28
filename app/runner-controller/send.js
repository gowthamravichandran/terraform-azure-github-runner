import { getConfigValue } from "./azure/config.js";
import { getServiceBusClient } from "./azure/clients/service-bus.js";
import { JOB_COMPLETED, JOB_QUEUED } from "./constants.js";
import { getLogger } from "./logger.js";

// name of the queue
const runnerQueue = await getConfigValue("azure-github-runners-queue");
const stateQueue = await getConfigValue("azure-github-state-queue");

export const runnerQueueSender = async (runnerName, action, imageConfig = null) => {
    const logger = getLogger();
    let queueName;
    if (action === JOB_QUEUED) {
        queueName = runnerQueue;
    } else if (action === JOB_COMPLETED) {
        queueName = stateQueue;
    }

    // create a Service Bus client using the connection string to the Service Bus namespace
    const sbClient = await getServiceBusClient();

    // createSender() can also be used to create a sender for a topic.
    const sender = sbClient.createSender(queueName);

    try {
        const messageBody = {
            runnerName,
            ...(imageConfig && { imageConfig })
        };

        await sender.sendMessages({
            body: messageBody,
            contentType: "application/json",
        });

        logger.debug("Message sent to queue", { 
            runnerName, 
            action, 
            queueName,
            ...(imageConfig && { imageId: imageConfig.id })
        });

        return true;
    } catch (error) {
        logger.warn("Message failed to send create runner queue with following error message", error);
        return false;
    } finally {
        await sender.close();
    }
};
