import { z } from 'zod';

export const capabilityActionSchema = z.object({
  type: z.enum(['devices.capabilities.on_off', 'devices.capabilities.color_setting', 'devices.capabilities.mode', 'devices.capabilities.range', 'devices.capabilities.toggle']),
  state: z.object({ instance: z.string().min(1), value: z.union([z.boolean(), z.number().finite(), z.string(), z.object({ h: z.number().finite(), s: z.number().finite(), v: z.number().finite() })]), relative: z.boolean().optional() }).strict(),
}).strict().superRefine((action, ctx) => {
  const { instance, value, relative } = action.state;
  const suffix = action.type.slice('devices.capabilities.'.length);
  let valid = true;
  if (suffix === 'on_off') valid = instance === 'on' && typeof value === 'boolean';
  if (suffix === 'toggle') valid = typeof value === 'boolean';
  if (suffix === 'mode') valid = typeof value === 'string';
  if (suffix === 'range') valid = typeof value === 'number';
  if (suffix === 'color_setting') {
    valid = instance === 'rgb' ? typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff
      : instance === 'temperature_k' ? typeof value === 'number' && value > 0
      : instance === 'hsv' ? typeof value === 'object' && value.h >= 0 && value.h <= 360 && value.s >= 0 && value.s <= 100 && value.v >= 0 && value.v <= 100
      : instance === 'scene' && typeof value === 'string';
  }
  if (!valid || (relative !== undefined && suffix !== 'range')) ctx.addIssue({ code: 'custom', message: 'Invalid capability state.' });
});
export const deviceActionSchema = z.object({ id: z.string().min(1), actions: z.array(capabilityActionSchema).min(1) }).strict();
export type CapabilityAction = z.infer<typeof capabilityActionSchema>;
export type DeviceAction = z.infer<typeof deviceActionSchema>;

const stateSchema = z.object({ instance: z.string(), value: z.unknown() }).passthrough().nullable();
const capabilitySchema = z.object({ type: z.string(), retrievable: z.boolean(), parameters: z.record(z.string(), z.unknown()), state: stateSchema, last_updated: z.number().optional() }).passthrough();
const entitySchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const deviceSchema = entitySchema.extend({ type: z.string(), capabilities: z.array(capabilitySchema), properties: z.array(capabilitySchema) });
export const operationResponseSchema = z.object({ status: z.literal('ok'), request_id: z.string() }).passthrough();
export const userInfoSchema = operationResponseSchema.extend({ rooms: z.array(entitySchema), groups: z.array(entitySchema), devices: z.array(deviceSchema), scenarios: z.array(entitySchema), households: z.array(entitySchema) });
export const deviceInfoSchema = operationResponseSchema.merge(deviceSchema).extend({ state: z.enum(['online', 'offline']) });
export const groupInfoSchema = operationResponseSchema.merge(entitySchema).extend({ type: z.string(), capabilities: z.array(capabilitySchema), devices: z.array(entitySchema.extend({ type: z.string() })) });
const actionResultSchema = z.object({ status: z.enum(['DONE', 'ERROR']), error_code: z.string().optional(), error_message: z.string().optional() }).passthrough();
export const actionResponseSchema = operationResponseSchema.extend({ devices: z.array(z.object({ id: z.string(), capabilities: z.array(z.object({ type: z.string(), state: z.object({ instance: z.string(), action_result: actionResultSchema }).passthrough() }).passthrough()) }).passthrough()) });
export type UserInfo = z.infer<typeof userInfoSchema>;
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;
export type GroupInfo = z.infer<typeof groupInfoSchema>;
export type ActionResponse = z.infer<typeof actionResponseSchema>;
export type OperationResponse = z.infer<typeof operationResponseSchema>;
