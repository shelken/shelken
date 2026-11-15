import { z } from "zod";

/**
 * config/tech-stack.yaml 的线上格式：条目既可写成 [label, color, logo?]，也可写成对象。
 * color 在此仅要求是字符串，是否属于色板由 normalizeBadgeItem 报出带分组上下文的错误。
 */

const RawBadgeItemSchema = z.union([
  z.tuple([z.string(), z.string(), z.string().nullish()]),
  z.looseObject({
    name: z.string().nullish(),
    label: z.string().nullish(),
    color: z.string(),
    logo: z.string().nullish(),
  }),
]);

const RawBadgeGroupSchema = z.looseObject({
  title: z.string(),
  slug: z.string().nullish(),
  items: z.array(RawBadgeItemSchema).optional(),
  badges: z.array(RawBadgeItemSchema).optional(),
});

export const RawBadgeConfigSchema = z.union([
  z.array(RawBadgeGroupSchema),
  z.looseObject({ groups: z.array(RawBadgeGroupSchema) }),
]);

export type RawBadgeItem = z.infer<typeof RawBadgeItemSchema>;

export type RawBadgeGroup = z.infer<typeof RawBadgeGroupSchema>;
