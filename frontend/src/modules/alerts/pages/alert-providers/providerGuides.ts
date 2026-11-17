/**
 * AlertProviders Provider Guides + 工具（2026-07-21 拆分）
 *
 * 把原 AlertProviders.tsx L34-106 的：
 * - PROVIDER_GUIDES 常量（prometheus / zabbix / grafana / webhook）
 * - getFormFields 函数
 * 全部抽出
 *
 * 拆分原则遵循 architecture.md §3.4.1 + 第 3 条「向后兼容的 import 路径」
 */

import type { AlertProvider, FormField } from './types';

export interface ProviderGuide {
  title: string;
  steps: string[];
  webhookFormat?: string;
  note?: string;
}

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  prometheus: {
    title: 'Prometheus Alertmanager 接入指南',
    steps: [
      '1. 在 Alertmanager 配置文件中添加 webhook receiver：',
      '2. 将下方 Webhook 地址填入 url 字段',
      '3. 重启 Alertmanager 使配置生效',
      '4. 告警触发后会自动推送到此地址，系统自动创建告警记录',
    ],
    webhookFormat: 'alertmanager',
    note: '⚠️ 本系统会自动解析 Alertmanager 的 JSON 格式告警，提取 labels 和 annotations 中的关键字段。',
  },
  zabbix: {
    title: 'Zabbix Webhook 接入指南',
    steps: [
      '1. Zabbix 管理后台 → 报警 → 动作媒介类型 → 创建媒介类型，类型选 Webhook',
      '2. URL 填写下方「Webhook 接收地址」（本平台是接收方，Zabbix 是推送方）',
      '3. 参数(Name/Value)按大写键名添加，平台按以下键解析：',
      '    TRIGGER.NAME={TRIGGER.NAME}  TRIGGER.SEVERITY={TRIGGER.SEVERITY}',
      '    HOST.NAME={HOST.NAME}  HOST.IP={HOST.IP}  EVENT.ID={EVENT.ID}',
      '    EVENT.VALUE={EVENT.VALUE}（1=故障 0=恢复，用于自动关闭告警）',
      '    ITEM.NAME={ITEM.NAME}  ITEM.VALUE={ITEM.VALUE}',
      '4. 消息模板选「问题」和「恢复」，动作(Actions)中关联此媒介',
    ],
    note: '⚠️ 配置下方无必填项——接收告警不需要填 Endpoint；下方的 URL/Token 仅用于从 Zabbix API 主动拉取（可选）。',
  },
  grafana: {
    title: 'Grafana Alerting 接入指南',
    steps: [
      '1. 在 Grafana → Alerting → Contact points → 新建 Webhook',
      '2. 将下方 Webhook 地址填入 URL 字段',
      '3. 在 Notification policies 中关联此 contact point',
      '4. 告警触发后 Grafana 会自动 POST JSON 到此地址',
    ],
    note: '⚠️ 本系统自动解析 Grafana 告警格式，包括告警名称、状态、标签和值。',
  },
  webhook: {
    title: '通用 Webhook 接入指南',
    steps: [
      '1. 将下方 Webhook 地址配置到任意支持 Webhook 的系统',
      '2. POST JSON 格式数据到该地址',
      '3. 支持字段：title(标题)、severity(严重度)、content(内容)、source(来源)',
    ],
    webhookFormat: 'generic',
    note: '💡 通用格式，适用于自定义系统或第三方工具。最小 JSON 示例：{"title":"告警标题","severity":"warning","content":"告警详情"}。接收 Zabbix 告警请改用「Zabbix」告警源（有专用解析）。',
  },
};

/** 从 provider schema 提取表单字段 */
export function getFormFields(provider: AlertProvider): FormField[] {
  if (!provider?.configSchema?.properties) return [];
  const required = provider.configSchema.required || [];
  return Object.entries(provider.configSchema.properties).map(([key, prop]) => ({
    key,
    label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    type: prop.type,
    description: prop.description || '',
    required: required.includes(key),
    default: prop.default,
    enum: prop.enum,
  }));
}
