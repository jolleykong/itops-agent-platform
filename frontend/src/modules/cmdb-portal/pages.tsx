/**
 * CMDB 驾驶舱原型页（demo）。
 *
 * 来源：用户提供的静态原型 `/AI_Project/CMDB前端UI原型.html`（2026-11-27），
 * 内容与样式经脚本移植（proto.ts / proto.css，自动生成勿手改）。
 * 定位：演示数据 + 原型样式，供功能导向评审；后续按评审结论接真实数据源。
 */
import { useEffect } from "react";
import "./proto.css";
import CiRelationsPage from "./CiRelationsPage";
import {
  SCREEN_RESOURCE,
  SCREEN_COST,
  SCREEN_SERVICE_RISK,
  SCREEN_COMPLIANCE,
  PAGE_TOPO_CANVAS,
  PAGE_IPAM,
  PAGE_IMPACT,
  PAGE_CI_DETAIL,
  PAGE_OPS_OBJECTS,
} from "./proto";

/** 大屏页头时钟（对应原型 clk1–clk4） */
function useClock(ids: string[]) {
  useEffect(() => {
    const tick = () => {
      const s = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = s;
      });
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function ProtoPage({ html }: { html: string }) {
  return (
    <div
      className="cmdb-proto"
      style={{ padding: "18px 22px 60px", maxWidth: 1920, margin: "0 auto" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ============ CIO 驾驶舱大屏（深色） ============ */

export function ScreenResource() {
  useClock(["clk1"]);
  return <ProtoPage html={SCREEN_RESOURCE} />;
}

export function ScreenCostCapacity() {
  useClock(["clk2"]);
  return <ProtoPage html={SCREEN_COST} />;
}

export function ScreenServiceRisk() {
  useClock(["clk3"]);
  return <ProtoPage html={SCREEN_SERVICE_RISK} />;
}

export function ScreenCompliance() {
  useClock(["clk4"]);
  return <ProtoPage html={SCREEN_COMPLIANCE} />;
}

/* ============ 功能页（浅色 workspace） ============ */

export function WorkbenchPage() {
  // 资源工作台接真实数据：CMDB 全量 CI 关系展开（/dc/ci-relations）
  return <CiRelationsPage />;
}

export function TopoCanvasPage() {
  return <ProtoPage html={PAGE_TOPO_CANVAS} />;
}

export function IpamPage() {
  return <ProtoPage html={PAGE_IPAM} />;
}

export function ImpactAnalysisPage() {
  return <ProtoPage html={PAGE_IMPACT} />;
}

export function CiDetailPage() {
  return <ProtoPage html={PAGE_CI_DETAIL} />;
}

export function OpsObjectsPage() {
  return <ProtoPage html={PAGE_OPS_OBJECTS} />;
}
