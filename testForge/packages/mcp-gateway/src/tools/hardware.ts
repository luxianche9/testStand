import { hardwareSchema } from "@testforge/contracts/devices";
import { appError } from "@testforge/contracts/errors";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const hardwareId = z.object({ hardwareId: z.string().min(1) }).strict();
const imageTarget = z.object({ hardwareId: z.string().min(1), portId: z.string().min(1).optional() }).strict();

export const HARDWARE_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "list_managed_hardware", description: "List live health for managed hardware.", capability: "hardware.read", schema: z.object({}).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listManagedHardware(context)
  }),
  defineTool({
    name: "list_hardware_catalog", description: "List local hardware definitions, ports and pins.", capability: "hardware.read", schema: z.object({}).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listHardware(context)
  }),
  defineTool({
    name: "get_hardware_definition", description: "Get one local hardware definition.", capability: "hardware.read", schema: hardwareId,
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.getHardware(context, input.hardwareId)
  }),
  defineTool({
    name: "save_hardware_definition", description: "Create or update a local hardware definition.", capability: "hardware.manage",
    schema: z.object({ hardware: hardwareSchema }).strict(), handler: (application, context, input) => application.devices.saveHardware(context, input.hardware)
  }),
  defineTool({
    name: "remove_hardware_definition", description: "Delete a local hardware definition and its images.", capability: "hardware.manage", schema: hardwareId,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.removeHardware(context, input.hardwareId)
  }),
  defineTool({
    name: "set_hardware_image", description: "Set a PNG, JPEG or WebP appearance/port image from base64.", capability: "hardware.manage",
    schema: z.object({ hardwareId: z.string().min(1), portId: z.string().min(1).optional(), imageBase64: z.string().min(1), fileName: z.string().default("") }).strict(),
    handler: (application, context, input) => application.devices.setHardwareImageBytes(context, input.hardwareId, input.portId, decodeBase64Image(input.imageBase64), input.fileName)
  }),
  defineTool({
    name: "remove_hardware_image", description: "Remove an appearance or port image.", capability: "hardware.manage", schema: imageTarget,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.removeHardwareImage(context, input.hardwareId, input.portId)
  })
];

function decodeBase64Image(value: string): Uint8Array {
  const trimmed = value.trim();
  const payload = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  if (!payload) throw appError("invalid_argument", "imageBase64 is required");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0) throw appError("invalid_argument", "imageBase64 is not valid base64");
  return new Uint8Array(bytes);
}
