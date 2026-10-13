const presets = [1, 10, 50, 100, 250, 500, 1000, 3000, 5000, 10000];

export function intervalValidation(value: string) {
  const milliseconds = Number(value);
  return value.trim() === '' || !Number.isFinite(milliseconds) || !Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 3600000
    ? '请输入 1—3600000 之间的整数毫秒。'
    : '';
}

export function IntervalInput({ value, onChange, id, className = '' }: { value: string; onChange: (value: string) => void; id: string; className?: string }) {
  const error = intervalValidation(value);
  return <label className={`field ${className}`} htmlFor={id}>检查间隔（毫秒）
    <input id={id} required type="number" min="1" max="3600000" step="1" list={`${id}-presets`} value={value} onInput={event => onChange(event.currentTarget.value)} onChange={event => onChange(event.target.value)} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
    <datalist id={`${id}-presets`}>{presets.map(milliseconds => <option key={milliseconds} value={milliseconds}>{milliseconds}ms</option>)}</datalist>
    <span className="field-help" id={`${id}-hint`}>1ms 为目标等待间隔；实际完整检查还取决于网页响应和其他任务。</span>
    {error ? <span className="field-validation" id={`${id}-error`} role="alert">{error}</span> : null}
  </label>;
}
