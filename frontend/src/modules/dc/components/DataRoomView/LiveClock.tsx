/**
 * 独立走时钟组件
 *
 * 为什么单独拆出来：机房看板页面的其余部分（机柜网格、告警、指标）都是静态渲染，
 * 如果把 timeStr 放在页面根组件的 state 里，每秒都会触发整棵树（258 个机柜卡片）重渲染，
 * 这是此前页面 CPU 占用高的主要原因。时钟自持 state 后，每秒只有本组件重渲染。
 */
import { useEffect, useState } from 'react';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function formatNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 星期${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 当前时间（秒级刷新，仅本组件重渲染） */
export function LiveClock({ color, size = 12 }: { color: string; size?: number }) {
  const [text, setText] = useState(formatNow);

  useEffect(() => {
    const timer = window.setInterval(() => setText(formatNow()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="font-mono tracking-[0.5px]" style={{ color, fontSize: size }}>
      {text}
    </span>
  );
}

/** 页面停留时长（秒级刷新，仅本组件重渲染） */
export function LiveUptime({ startTime, color, size = 11 }: { startTime: number; color: string; size?: number }) {
  const calc = () => {
    const totalSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    return `${days}天${hours}小时${mins}分`;
  };
  const [text, setText] = useState(calc);

  useEffect(() => {
    const timer = window.setInterval(() => setText(calc()), 1000);
    return () => window.clearInterval(timer);
    // startTime 变化时重建定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime]);

  return (
    <span className="font-mono" style={{ color, fontSize: size }}>
      {text}
    </span>
  );
}

export default LiveClock;
