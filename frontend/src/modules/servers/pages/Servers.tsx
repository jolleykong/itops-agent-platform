/**
 * 服务器资产分层视图（2026-11-24）
 * category 不传 = 硬件层+OS 层混合的旧视图；'hardware'/'os'/'storage' = 分层视图
 * 数据由后端 /servers?category= 过滤（分类规则见 serverAssetCategory.ts）
 */
export { default } from './servers/index';

export type ServerAssetCategoryProp = 'hardware' | 'os' | 'storage';