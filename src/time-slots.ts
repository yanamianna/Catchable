export const HALF_HOUR_TIMES = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);

export function halfHourRange(start: string, end: string) {
  return HALF_HOUR_TIMES.filter(time => time >= start && time <= end);
}

export function taskTimeLabel(task: { timeStart: string; timeEnd: string; timeSlots?: string[] }, compact = false) {
  if (!task.timeSlots?.length) return `${task.timeStart}–${task.timeEnd}`;
  const times = task.timeSlots;
  return compact && times.length > 5 ? `${times.slice(0, 3).join('、')} 等 ${times.length} 个时段` : times.join('、');
}
