import { getInitialRunnerWarmPool } from "./index.js";
import { listBusyGitHubRunners } from "../github.js";

const runnerMap = new Map();

export const initializeRunnerState = async () => {
    const [warmPool, busyRunners] = await Promise.all([
        getInitialRunnerWarmPool(),
        listBusyGitHubRunners(),
    ]);

    warmPool.forEach((runner) => {
        addRunnerToState(runner);
    });

    busyRunners.forEach((runner) => {
        addRunnerToState(runner.name, true);
    });
};

export const addRunnerToState = (runnerName, imageConfig, busy = false) => {
    runnerMap.set(runnerName, {
        busy,
        imageId: imageConfig.id,
        imageType: imageConfig.type,
        labels: imageConfig.labels,
        vmSize: imageConfig.vm_size
    });
};

export const removeRunnerFromState = (runnerName) => {
    runnerMap.delete(runnerName);
};

export const setRunnerAsBusyInState = (runnerName) => {
    runnerMap.set(runnerName, {
        busy: true,
    });
};

export const getRunnerWarmPoolFromState = (imageId = null) => {
    const result = {};
    
    runnerMap.forEach((runnerState, runnerName) => {
        if (!runnerState.busy && (!imageId || runnerState.imageId === imageId)) {
            result[runnerName] = runnerState;
        }
    });
    
    return result;
};

export const getWarmPoolSizeByImage = () => {
    const warmPoolSizes = new Map();
    
    runnerMap.forEach((runnerState) => {
        if (!runnerState.busy) {
            const count = warmPoolSizes.get(runnerState.imageId) || 0;
            warmPoolSizes.set(runnerState.imageId, count + 1);
        }
    });
    
    return warmPoolSizes;
};

export const getRunnerState = (onlyReturnIdleRunners = false) => {
    const result = {};

    runnerMap.forEach((runnerState, runnerName) => {
        if (onlyReturnIdleRunners && !runnerState.busy) {
            result[runnerName] = runnerState;
        } else if (!onlyReturnIdleRunners) {
            result[runnerName] = runnerState;
        }
    });

    return result;
};

export const getNumberOfRunnersFromState = () => runnerMap.size;

export const getNumberOfRunnersInWarmPoolFromState = () => Object.keys(getRunnerWarmPoolFromState()).length;
