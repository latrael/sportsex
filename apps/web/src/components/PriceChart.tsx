'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export type PricePoint = { t: string; price: number };

export default function PriceChart({ data }: { data: PricePoint[] }) {
  if (data.length === 0) {
    return <div className="text-mute text-sm py-8 text-center">No price history yet.</div>;
  }
  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="#2a3447" strokeDasharray="3 3" />
          <XAxis dataKey="t" stroke="#8593ad" tick={{ fontSize: 10 }} />
          <YAxis stroke="#8593ad" tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#121826', border: '1px solid #2a3447', fontSize: 12 }}
            labelStyle={{ color: '#8593ad' }}
          />
          <Line
            type="monotone"
            dataKey="price"
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
