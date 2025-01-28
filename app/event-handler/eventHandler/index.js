import { validateRequest, getWebHookEventsQueueSender } from "./util.js";

export const eventHandler = async function (context, req) {
    context.log.verbose("JavaScript HTTP trigger function processed a request.", req.body);

    const isValid = await validateRequest(context, req);
    let response;

    if (isValid) {
        const jobLabels = req.body?.workflow_job?.labels || [];
        const imageConfigs = JSON.parse(await context.bindings.appConfig.azure_gallery_images);
        
        // Find the first image config that has all its labels included in the job labels
        const matchingImage = imageConfigs.find(img => 
            img.labels.every(label => jobLabels.includes(label))
        );

        if (matchingImage) {
            response = {
                body: `Valid webhook message received. Queued [${req.body?.workflow_job?.run_url}] for processing with image ${matchingImage.id}`,
            };

            const sender = await getWebHookEventsQueueSender(context);
            const body = {
                ...req.body,
                matched_image_config: matchingImage
            };

            await sender.sendMessages({ body });
            context.log.verbose("Placed message on queue with matched image config", { sender, imageId: matchingImage.id });
        } else {
            response = {
                status: 400,
                body: `No matching runner image found for labels: ${jobLabels.join(", ")}`,
            };
            context.log.warn("No matching runner image found for labels", { jobLabels });
        }
    } else {
        response = {
            status: 403,
            body: "Discarding invalid request",
        };
    }

    context.log.verbose("prepared response", response);
    context.res = response;
};
