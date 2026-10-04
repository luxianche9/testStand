// Generated from openapi.json by scripts/generate-openapi-types.mjs. Do not edit.
export interface paths {
    "/api/ops/agents.install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.install */
        post: operations["agents.install"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.listTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Built-in gateway tools plus the device tools the Agent may call. */
        post: operations["agents.listTools"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.openCodeConnection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** ``{url, username, password}`` of the running OpenCode instance, or null. */
        post: operations["agents.openCodeConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.openCodeStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.openCodeStatus */
        post: operations["agents.openCodeStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.preview */
        post: operations["agents.preview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.remove */
        post: operations["agents.remove"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.restartOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.restartOpenCode */
        post: operations["agents.restartOpenCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.rotateGatewayToken": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A new gateway token for Codex and OpenCode (which restarts to pick it up). */
        post: operations["agents.rotateGatewayToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.startOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.startOpenCode */
        post: operations["agents.startOpenCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Whether Codex is connected to this gateway, and what is missing. */
        post: operations["agents.status"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.stopOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.stopOpenCode */
        post: operations["agents.stopOpenCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/agents.test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** agents.test */
        post: operations["agents.test"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.callTool": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.callTool */
        post: operations["devices.callTool"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.exportBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.exportBundle */
        post: operations["devices.exportBundle"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.getDefinition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** The managed device's ``/device`` declaration as cached (read-only, §9.7). */
        post: operations["devices.getDefinition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.getHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.getHardware */
        post: operations["devices.getHardware"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.importBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.importBundle */
        post: operations["devices.importBundle"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.inspectBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.inspectBundle */
        post: operations["devices.inspectBundle"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.inspectPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** What installing a ``.tsdev`` would do: manifest, files, SHA-256 and any problems. */
        post: operations["devices.inspectPackage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.installPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install a device package (human only: it runs code in the backend). */
        post: operations["devices.installPackage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listDevices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.listDevices */
        post: operations["devices.listDevices"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listDevicesWithStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.listDevicesWithStatus */
        post: operations["devices.listDevicesWithStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listDeviceTypes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Device plugins installed with the backend (``teststand.devices`` entry points). */
        post: operations["devices.listDeviceTypes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.listHardware */
        post: operations["devices.listHardware"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listManagedHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.listManagedHardware */
        post: operations["devices.listManagedHardware"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listPackages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Installed device packages (``.tsdev``), with any change waiting for a restart. */
        post: operations["devices.listPackages"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.listTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.listTools */
        post: operations["devices.listTools"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.refreshDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.refreshDevice */
        post: operations["devices.refreshDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.removeDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.removeDevice */
        post: operations["devices.removeDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.removeHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.removeHardware */
        post: operations["devices.removeHardware"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.saveDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.saveDevice */
        post: operations["devices.saveDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.saveHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** devices.saveHardware */
        post: operations["devices.saveHardware"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/devices.uninstallPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Remove an installed device package; takes effect at the next start. */
        post: operations["devices.uninstallPackage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/manual.invokeTool": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** manual.invokeTool */
        post: operations["manual.invokeTool"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.document": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.document */
        post: operations["projects.document"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.forgetRecent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.forgetRecent */
        post: operations["projects.forgetRecent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.initializeFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.initializeFolder */
        post: operations["projects.initializeFolder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.inspectFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.inspectFolder */
        post: operations["projects.inspectFolder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.leaveProject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.leaveProject */
        post: operations["projects.leaveProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.listRecent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.listRecent */
        post: operations["projects.listRecent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.openFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.openFolder */
        post: operations["projects.openFolder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/projects.saveProject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** projects.saveProject */
        post: operations["projects.saveProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/settings.get": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Theme, layouts, recent projects and the model settings (never the key). */
        post: operations["settings.get"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/settings.getLlm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** settings.getLlm */
        post: operations["settings.getLlm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/settings.saveLlm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Save the OpenCode model settings; the key goes to the credential store. OpenCode
         *     restarts, starts or stops to match, after this returns.
         */
        post: operations["settings.saveLlm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/settings.update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** settings.update */
        post: operations["settings.update"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/streams.expect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** streams.expect */
        post: operations["streams.expect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/streams.listStreams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** streams.listStreams */
        post: operations["streams.listStreams"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/streams.observe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** streams.observe */
        post: operations["streams.observe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/streams.window": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A run recording over ``[t0, t1]``, min/max downsampled to ``width`` pixel columns
         *     (design doc 5.9.3); the live view is ``GET /api/live``.
         */
        post: operations["streams.window"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/system.answerConfirmation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve or decline a pending confirmation; only a human holds ``agents.manage``. */
        post: operations["system.answerConfirmation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/system.dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** system.dashboard */
        post: operations["system.dashboard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/system.listConfirmations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** The Agent's high-risk operations waiting for the operator (design doc 8.4). */
        post: operations["system.listConfirmations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.abortBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.abortBatch */
        post: operations["testing.abortBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.abortRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.abortRun */
        post: operations["testing.abortRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.analyzePlanDraft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.analyzePlanDraft */
        post: operations["testing.analyzePlanDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.answerManualCheck": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** The operator's answer to a waiting ``ManualCheck`` (design §7.2); never an Agent's. */
        post: operations["testing.answerManualCheck"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.applyPlanOperations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.applyPlanOperations */
        post: operations["testing.applyPlanOperations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.checkIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate ICD text (unsaved or ``name``'s file) and trial-decode sample records. */
        post: operations["testing.checkIcd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.createPlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.createPlan */
        post: operations["testing.createPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.currentBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.currentBatch */
        post: operations["testing.currentBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.currentRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.currentRun */
        post: operations["testing.currentRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.currentUnit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.currentUnit */
        post: operations["testing.currentUnit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.deletePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.deletePlan */
        post: operations["testing.deletePlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.getBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.getBatch */
        post: operations["testing.getBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.getRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.getRun */
        post: operations["testing.getRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.getRunTimeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.getRunTimeline */
        post: operations["testing.getRunTimeline"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listDeviceTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listDeviceTools */
        post: operations["testing.listDeviceTools"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listIcds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listIcds */
        post: operations["testing.listIcds"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listItemStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listItemStatus */
        post: operations["testing.listItemStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listPlans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listPlans */
        post: operations["testing.listPlans"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listRecoveryItems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listRecoveryItems */
        post: operations["testing.listRecoveryItems"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listRuns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listRuns */
        post: operations["testing.listRuns"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listRunStreams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listRunStreams */
        post: operations["testing.listRunStreams"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.listStepCatalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.listStepCatalog */
        post: operations["testing.listStepCatalog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.loadPlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.loadPlan */
        post: operations["testing.loadPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.pauseRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.pauseRun */
        post: operations["testing.pauseRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readIcd */
        post: operations["testing.readIcd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readRunIo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readRunIo */
        post: operations["testing.readRunIo"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readRunLog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readRunLog */
        post: operations["testing.readRunLog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readRunMessages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readRunMessages */
        post: operations["testing.readRunMessages"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readRunResults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readRunResults */
        post: operations["testing.readRunResults"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.readRunStream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.readRunStream */
        post: operations["testing.readRunStream"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.reconcileOperation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.reconcileOperation */
        post: operations["testing.reconcileOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.rejudgeRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.rejudgeRun */
        post: operations["testing.rejudgeRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.reorderItems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.reorderItems */
        post: operations["testing.reorderItems"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.resumeRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.resumeRun */
        post: operations["testing.resumeRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.saveIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Write ``icd/<name>.icd.yaml``; an invalid ICD is rejected and nothing is written. */
        post: operations["testing.saveIcd"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.savePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.savePlan */
        post: operations["testing.savePlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.startBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.startBatch */
        post: operations["testing.startBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.startRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.startRun */
        post: operations["testing.startRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.validatePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.validatePlan */
        post: operations["testing.validatePlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.waitForBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.waitForBatch */
        post: operations["testing.waitForBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/testing.waitForRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** testing.waitForRun */
        post: operations["testing.waitForRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.addManagedHardwareToCanvas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.addManagedHardwareToCanvas */
        post: operations["wiring.addManagedHardwareToCanvas"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.cancelTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.cancelTask */
        post: operations["wiring.cancelTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.completeTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.completeTask */
        post: operations["wiring.completeTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.getTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.getTask */
        post: operations["wiring.getTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.listChanges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.listChanges */
        post: operations["wiring.listChanges"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.listTasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.listTasks */
        post: operations["wiring.listTasks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.requestTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.requestTask */
        post: operations["wiring.requestTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.startTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.startTask */
        post: operations["wiring.startTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ops/wiring.updateDocument": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** wiring.updateDocument */
        post: operations["wiring.updateDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** AgentsInstallRequest */
        AgentsInstallRequest: {
            /**
             * Agent
             * @constant
             */
            agent: "codex";
        };
        /** AgentsListToolsRequest */
        AgentsListToolsRequest: Record<string, never>;
        /** AgentsOpenCodeConnectionRequest */
        AgentsOpenCodeConnectionRequest: Record<string, never>;
        /** AgentsOpenCodeStatusRequest */
        AgentsOpenCodeStatusRequest: Record<string, never>;
        /** AgentsPreviewRequest */
        AgentsPreviewRequest: {
            /**
             * Agent
             * @constant
             */
            agent: "codex";
        };
        /** AgentsRemoveRequest */
        AgentsRemoveRequest: {
            /**
             * Agent
             * @constant
             */
            agent: "codex";
        };
        /** AgentsRestartOpenCodeRequest */
        AgentsRestartOpenCodeRequest: Record<string, never>;
        /** AgentsRotateGatewayTokenRequest */
        AgentsRotateGatewayTokenRequest: Record<string, never>;
        /** AgentsStartOpenCodeRequest */
        AgentsStartOpenCodeRequest: Record<string, never>;
        /** AgentsStatusRequest */
        AgentsStatusRequest: {
            /**
             * Agent
             * @constant
             */
            agent: "codex";
        };
        /** AgentsStopOpenCodeRequest */
        AgentsStopOpenCodeRequest: Record<string, never>;
        /** AgentsTestRequest */
        AgentsTestRequest: {
            /**
             * Agent
             * @constant
             */
            agent: "codex";
        };
        /** DevicesCallToolRequest */
        DevicesCallToolRequest: {
            /** Args */
            args: object;
            /** Name */
            name: string;
        };
        /** DevicesExportBundleRequest */
        DevicesExportBundleRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** DevicesGetDefinitionRequest */
        DevicesGetDefinitionRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** DevicesGetHardwareRequest */
        DevicesGetHardwareRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** DevicesImportBundleRequest */
        DevicesImportBundleRequest: {
            /**
             * Data
             * Format: base64url
             */
            data: Uint8Array;
        };
        /** DevicesInspectBundleRequest */
        DevicesInspectBundleRequest: {
            /**
             * Data
             * Format: base64url
             */
            data: Uint8Array;
        };
        /** DevicesInspectPackageRequest */
        DevicesInspectPackageRequest: {
            /**
             * Data
             * Format: base64url
             */
            data: Uint8Array;
        };
        /** DevicesInstallPackageRequest */
        DevicesInstallPackageRequest: {
            /**
             * Data
             * Format: base64url
             */
            data: Uint8Array;
        };
        /** DevicesListDevicesRequest */
        DevicesListDevicesRequest: Record<string, never>;
        /** DevicesListDevicesWithStatusRequest */
        DevicesListDevicesWithStatusRequest: Record<string, never>;
        /** DevicesListDeviceTypesRequest */
        DevicesListDeviceTypesRequest: Record<string, never>;
        /** DevicesListHardwareRequest */
        DevicesListHardwareRequest: Record<string, never>;
        /** DevicesListManagedHardwareRequest */
        DevicesListManagedHardwareRequest: Record<string, never>;
        /** DevicesListPackagesRequest */
        DevicesListPackagesRequest: Record<string, never>;
        /** DevicesListToolsRequest */
        DevicesListToolsRequest: Record<string, never>;
        /** DevicesRefreshDeviceRequest */
        DevicesRefreshDeviceRequest: {
            /** Deviceid */
            deviceId: string;
        };
        /** DevicesRemoveDeviceRequest */
        DevicesRemoveDeviceRequest: {
            /** Deviceid */
            deviceId: string;
        };
        /** DevicesRemoveHardwareRequest */
        DevicesRemoveHardwareRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** DevicesSaveDeviceRequest */
        DevicesSaveDeviceRequest: {
            /** Input */
            input: object;
        };
        /** DevicesSaveHardwareRequest */
        DevicesSaveHardwareRequest: {
            /** Input */
            input: object;
        };
        /** DevicesUninstallPackageRequest */
        DevicesUninstallPackageRequest: {
            /** Devicetype */
            deviceType: string;
        };
        /** ManualInvokeToolRequest */
        ManualInvokeToolRequest: {
            /** Raw */
            raw: object;
        };
        /** ProjectsDocumentRequest */
        ProjectsDocumentRequest: Record<string, never>;
        /** ProjectsForgetRecentRequest */
        ProjectsForgetRecentRequest: {
            /** Rootpath */
            rootPath: string;
        };
        /** ProjectsInitializeFolderRequest */
        ProjectsInitializeFolderRequest: {
            /** Rootpath */
            rootPath: string;
        };
        /** ProjectsInspectFolderRequest */
        ProjectsInspectFolderRequest: {
            /** Rootpath */
            rootPath: string;
        };
        /** ProjectsLeaveProjectRequest */
        ProjectsLeaveProjectRequest: Record<string, never>;
        /** ProjectsListRecentRequest */
        ProjectsListRecentRequest: Record<string, never>;
        /** ProjectsOpenFolderRequest */
        ProjectsOpenFolderRequest: {
            /** Rootpath */
            rootPath: string;
        };
        /** ProjectsSaveProjectRequest */
        ProjectsSaveProjectRequest: Record<string, never>;
        /** SettingsGetLlmRequest */
        SettingsGetLlmRequest: Record<string, never>;
        /** SettingsGetRequest */
        SettingsGetRequest: Record<string, never>;
        /** SettingsSaveLlmRequest */
        SettingsSaveLlmRequest: {
            /**
             * Apikey
             * @default null
             */
            apiKey?: string | null;
            /** Baseurl */
            baseUrl: string;
            /**
             * Clearapikey
             * @default false
             */
            clearApiKey?: boolean;
            /** Model */
            model: string;
        };
        /** SettingsUpdateRequest */
        SettingsUpdateRequest: {
            /**
             * Projectview
             * @default null
             */
            projectView?: ("bench" | "plans" | "runs") | null;
            /**
             * Theme
             * @default null
             */
            theme?: ("system" | "light" | "dark") | null;
            /**
             * Welcomelayout
             * @default null
             */
            welcomeLayout?: ("grid" | "list") | null;
        };
        /** StreamsExpectRequest */
        StreamsExpectRequest: {
            /** Hardwareid */
            hardwareId: string;
            /** Match */
            match: object;
            /** Streamid */
            streamId: string;
            /** Withinms */
            withinMs: number;
        };
        /** StreamsListStreamsRequest */
        StreamsListStreamsRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** StreamsObserveRequest */
        StreamsObserveRequest: {
            /**
             * Assertions
             * @default null
             */
            assertions?: object[] | null;
            /** Hardwareid */
            hardwareId: string;
            /**
             * Minsamples
             * @default 3
             */
            minSamples?: number;
            /** Streamid */
            streamId: string;
            /** Windowms */
            windowMs: number;
        };
        /** StreamsWindowRequest */
        StreamsWindowRequest: {
            /** Keys */
            keys: string[];
            /** Runid */
            runId: string;
            /** T0 */
            t0: number;
            /** T1 */
            t1: number;
            /** Width */
            width: number;
        };
        /** SystemAnswerConfirmationRequest */
        SystemAnswerConfirmationRequest: {
            /** Approve */
            approve: boolean;
            /** Confirmationid */
            confirmationId: string;
        };
        /** SystemDashboardRequest */
        SystemDashboardRequest: Record<string, never>;
        /** SystemListConfirmationsRequest */
        SystemListConfirmationsRequest: Record<string, never>;
        /** TestingAbortBatchRequest */
        TestingAbortBatchRequest: {
            /** Batchid */
            batchId: string;
        };
        /** TestingAbortRunRequest */
        TestingAbortRunRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingAnalyzePlanDraftRequest */
        TestingAnalyzePlanDraftRequest: {
            /** Input */
            input: object;
        };
        /** TestingAnswerManualCheckRequest */
        TestingAnswerManualCheckRequest: {
            /** Input */
            input: object;
        };
        /** TestingApplyPlanOperationsRequest */
        TestingApplyPlanOperationsRequest: {
            /** Input */
            input: object;
        };
        /** TestingCheckIcdRequest */
        TestingCheckIcdRequest: {
            /** Input */
            input: object;
        };
        /** TestingCreatePlanRequest */
        TestingCreatePlanRequest: {
            /** Input */
            input: object;
        };
        /** TestingCurrentBatchRequest */
        TestingCurrentBatchRequest: Record<string, never>;
        /** TestingCurrentRunRequest */
        TestingCurrentRunRequest: Record<string, never>;
        /** TestingCurrentUnitRequest */
        TestingCurrentUnitRequest: Record<string, never>;
        /** TestingDeletePlanRequest */
        TestingDeletePlanRequest: {
            /** Planid */
            planId: string;
        };
        /** TestingGetBatchRequest */
        TestingGetBatchRequest: {
            /** Batchid */
            batchId: string;
        };
        /** TestingGetRunRequest */
        TestingGetRunRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingGetRunTimelineRequest */
        TestingGetRunTimelineRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingListDeviceToolsRequest */
        TestingListDeviceToolsRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** TestingListIcdsRequest */
        TestingListIcdsRequest: Record<string, never>;
        /** TestingListItemStatusRequest */
        TestingListItemStatusRequest: Record<string, never>;
        /** TestingListPlansRequest */
        TestingListPlansRequest: Record<string, never>;
        /** TestingListRecoveryItemsRequest */
        TestingListRecoveryItemsRequest: Record<string, never>;
        /** TestingListRunsRequest */
        TestingListRunsRequest: {
            /**
             * Input
             * @default null
             */
            input?: object | null;
        };
        /** TestingListRunStreamsRequest */
        TestingListRunStreamsRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingListStepCatalogRequest */
        TestingListStepCatalogRequest: Record<string, never>;
        /** TestingLoadPlanRequest */
        TestingLoadPlanRequest: {
            /** Planid */
            planId: string;
        };
        /** TestingPauseRunRequest */
        TestingPauseRunRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingReadIcdRequest */
        TestingReadIcdRequest: {
            /** Name */
            name: string;
        };
        /** TestingReadRunIoRequest */
        TestingReadRunIoRequest: {
            /**
             * Limit
             * @default 50
             */
            limit?: number;
            /** Runid */
            runId: string;
            /**
             * Stepid
             * @default null
             */
            stepId?: string | null;
        };
        /** TestingReadRunLogRequest */
        TestingReadRunLogRequest: {
            /**
             * Aftereventsequence
             * @default 0
             */
            afterEventSequence?: number;
            /**
             * Afterresultsequence
             * @default 0
             */
            afterResultSequence?: number;
            /**
             * Eventlimit
             * @default 1000
             */
            eventLimit?: number;
            /**
             * Resultlimit
             * @default 1000
             */
            resultLimit?: number;
            /** Runid */
            runId: string;
        };
        /** TestingReadRunMessagesRequest */
        TestingReadRunMessagesRequest: {
            /**
             * Query
             * @default null
             */
            query?: object | null;
            /** Runid */
            runId: string;
        };
        /** TestingReadRunResultsRequest */
        TestingReadRunResultsRequest: {
            /**
             * Aftersequence
             * @default 0
             */
            afterSequence?: number;
            /** Runid */
            runId: string;
        };
        /** TestingReadRunStreamRequest */
        TestingReadRunStreamRequest: {
            /** Key */
            key: string;
            /**
             * Query
             * @default null
             */
            query?: object | null;
            /** Runid */
            runId: string;
        };
        /** TestingReconcileOperationRequest */
        TestingReconcileOperationRequest: {
            /** Input */
            input: object;
        };
        /** TestingRejudgeRunRequest */
        TestingRejudgeRunRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingReorderItemsRequest */
        TestingReorderItemsRequest: {
            /** Input */
            input: object;
        };
        /** TestingResumeRunRequest */
        TestingResumeRunRequest: {
            /** Runid */
            runId: string;
        };
        /** TestingSaveIcdRequest */
        TestingSaveIcdRequest: {
            /** Input */
            input: object;
        };
        /** TestingSavePlanRequest */
        TestingSavePlanRequest: {
            /** Baserevision */
            baseRevision: number;
            /** Plan */
            plan: object;
        };
        /** TestingStartBatchRequest */
        TestingStartBatchRequest: {
            /** Input */
            input: object;
        };
        /** TestingStartRunRequest */
        TestingStartRunRequest: {
            /** Input */
            input: object;
        };
        /** TestingValidatePlanRequest */
        TestingValidatePlanRequest: {
            /** Planid */
            planId: string;
        };
        /** TestingWaitForBatchRequest */
        TestingWaitForBatchRequest: {
            /** Batchid */
            batchId: string;
            /**
             * Timeoutms
             * @default 30000
             */
            timeoutMs?: number;
        };
        /** TestingWaitForRunRequest */
        TestingWaitForRunRequest: {
            /**
             * Aftersequence
             * @default 0
             */
            afterSequence?: number;
            /** Runid */
            runId: string;
            /**
             * Timeoutms
             * @default 30000
             */
            timeoutMs?: number;
        };
        WireError: {
            category: string;
            details?: unknown;
            message: string;
        };
        /** WiringAddManagedHardwareToCanvasRequest */
        WiringAddManagedHardwareToCanvasRequest: {
            /** Hardwareid */
            hardwareId: string;
        };
        /** WiringCancelTaskRequest */
        WiringCancelTaskRequest: {
            /**
             * Message
             * @default null
             */
            message?: string | null;
            /** Taskid */
            taskId: string;
        };
        /** WiringCompleteTaskRequest */
        WiringCompleteTaskRequest: {
            /**
             * Message
             * @default null
             */
            message?: string | null;
            /** Outcome */
            outcome: string;
            /** Taskid */
            taskId: string;
        };
        /** WiringGetTaskRequest */
        WiringGetTaskRequest: {
            /** Taskid */
            taskId: string;
        };
        /** WiringListChangesRequest */
        WiringListChangesRequest: {
            /**
             * Input
             * @default null
             */
            input?: object | null;
        };
        /** WiringListTasksRequest */
        WiringListTasksRequest: {
            /**
             * Input
             * @default null
             */
            input?: object | null;
        };
        /** WiringRequestTaskRequest */
        WiringRequestTaskRequest: {
            /** Input */
            input: object;
        };
        /** WiringStartTaskRequest */
        WiringStartTaskRequest: {
            /**
             * Operatorname
             * @default null
             */
            operatorName?: string | null;
            /** Taskid */
            taskId: string;
        };
        /** WiringUpdateDocumentRequest */
        WiringUpdateDocumentRequest: {
            /** Wiring */
            wiring: object;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    "agents.install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentsInstallRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.listTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsListToolsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.openCodeConnection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsOpenCodeConnectionRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object | null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.openCodeStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsOpenCodeStatusRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentsPreviewRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentsRemoveRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.restartOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsRestartOpenCodeRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.rotateGatewayToken": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsRotateGatewayTokenRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.startOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsStartOpenCodeRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentsStatusRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.stopOpenCode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AgentsStopOpenCodeRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "agents.test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentsTestRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.callTool": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesCallToolRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.exportBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesExportBundleRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Uint8Array;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.getDefinition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesGetDefinitionRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object | null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.getHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesGetHardwareRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.importBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesImportBundleRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.inspectBundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesInspectBundleRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.inspectPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesInspectPackageRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.installPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesInstallPackageRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listDevices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListDevicesRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listDevicesWithStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListDevicesWithStatusRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listDeviceTypes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListDeviceTypesRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListHardwareRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listManagedHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListManagedHardwareRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listPackages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListPackagesRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.listTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DevicesListToolsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.refreshDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesRefreshDeviceRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.removeDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesRemoveDeviceRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.removeHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesRemoveHardwareRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.saveDevice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesSaveDeviceRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.saveHardware": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesSaveHardwareRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "devices.uninstallPackage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevicesUninstallPackageRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "manual.invokeTool": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManualInvokeToolRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.document": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProjectsDocumentRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object | null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.forgetRecent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectsForgetRecentRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.initializeFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectsInitializeFolderRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.inspectFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectsInspectFolderRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.leaveProject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProjectsLeaveProjectRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.listRecent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProjectsListRecentRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.openFolder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectsOpenFolderRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "projects.saveProject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ProjectsSaveProjectRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "settings.get": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SettingsGetRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "settings.getLlm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SettingsGetLlmRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "settings.saveLlm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsSaveLlmRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "settings.update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SettingsUpdateRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "streams.expect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StreamsExpectRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "streams.listStreams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StreamsListStreamsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "streams.observe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StreamsObserveRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "streams.window": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StreamsWindowRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "system.answerConfirmation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SystemAnswerConfirmationRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "system.dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SystemDashboardRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "system.listConfirmations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["SystemListConfirmationsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.abortBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingAbortBatchRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.abortRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingAbortRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.analyzePlanDraft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingAnalyzePlanDraftRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.answerManualCheck": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingAnswerManualCheckRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.applyPlanOperations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingApplyPlanOperationsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.checkIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingCheckIcdRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.createPlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingCreatePlanRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.currentBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingCurrentBatchRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object | null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.currentRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingCurrentRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object | null;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.currentUnit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingCurrentUnitRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.deletePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingDeletePlanRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.getBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingGetBatchRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.getRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingGetRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.getRunTimeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingGetRunTimelineRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listDeviceTools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingListDeviceToolsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listIcds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListIcdsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listItemStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListItemStatusRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listPlans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListPlansRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listRecoveryItems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListRecoveryItemsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listRuns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListRunsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listRunStreams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingListRunStreamsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.listStepCatalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TestingListStepCatalogRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.loadPlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingLoadPlanRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.pauseRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingPauseRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadIcdRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readRunIo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadRunIoRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readRunLog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadRunLogRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readRunMessages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadRunMessagesRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readRunResults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadRunResultsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.readRunStream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReadRunStreamRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.reconcileOperation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReconcileOperationRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.rejudgeRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingRejudgeRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.reorderItems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingReorderItemsRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.resumeRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingResumeRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.saveIcd": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingSaveIcdRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.savePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingSavePlanRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.startBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingStartBatchRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.startRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingStartRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.validatePlan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingValidatePlanRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.waitForBatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingWaitForBatchRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "testing.waitForRun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TestingWaitForRunRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.addManagedHardwareToCanvas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringAddManagedHardwareToCanvasRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.cancelTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringCancelTaskRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.completeTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringCompleteTaskRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.getTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringGetTaskRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.listChanges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["WiringListChangesRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.listTasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["WiringListTasksRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object[];
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.requestTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringRequestTaskRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.startTask": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringStartTaskRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
    "wiring.updateDocument": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WiringUpdateDocumentRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": object;
                };
            };
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: components["schemas"]["WireError"];
                    };
                };
            };
        };
    };
}
