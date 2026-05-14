'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type StatItem = { label: string; value: string | number };

type Props = {
  assetKind: 'player' | 'team';
  assetId: number;
  price: number;
  signedIn: boolean;
  ownedShares: number;
  balance: number;
  stats?: StatItem[];
};

export default function TradeWidget({ assetKind, assetId, price, signedIn, ownedShares, balance, stats }: Props) {
  const [shares, setShares] = useState(1);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const cost = shares * price;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetKind, assetId, side, shares }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error || 'Order failed');
        return;
      }
      setMsg(`Filled ${side} ${shares} @ ${j.price.toFixed(2)}`);
      router.refresh();
    });
  }

  if (!signedIn) {
    return (
      <div className="card">
        <p className="text-mute text-sm mb-2">Sign in to trade.</p>
        <a href="/login" className="btn btn-primary">Sign in</a>
      </div>
    );
  }

  return (
    <form className="card space-y-3" onSubmit={submit}>
      {stats && stats.length > 0 && (
        <div>
          <div className="text-xs text-mute uppercase mb-2">Season Stats</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {stats.map((s) => (
              <div key={s.label} className="flex justify-between">
                <span className="text-mute">{s.label}</span>
                <span className="font-mono">{s.value}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-panel2 mt-3" />
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setSide('buy')}
          className={`btn flex-1 justify-center ${side === 'buy' ? 'btn-primary' : ''}`}
        >Buy</button>
        <button
          type="button"
          onClick={() => setSide('sell')}
          className={`btn flex-1 justify-center ${side === 'sell' ? 'btn-danger' : ''}`}
        >Sell</button>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-mute uppercase">Shares</label>
        <input
          className="input"
          type="number"
          min={1}
          max={1000}
          value={shares}
          onChange={(e) => setShares(Math.max(1, parseInt(e.target.value || '1', 10)))}
        />
      </div>
      <div className="text-sm space-y-1">
        <div className="flex justify-between"><span className="text-mute">Price</span><span className="font-mono">{price.toFixed(2)}</span></div>
        <div className="flex justify-between"><span className="text-mute">Total</span><span className="font-mono">{cost.toFixed(2)}</span></div>
        <div className="flex justify-between"><span className="text-mute">Balance</span><span className="font-mono">{balance.toLocaleString()}</span></div>
        <div className="flex justify-between"><span className="text-mute">You own</span><span className="font-mono">{ownedShares}</span></div>
      </div>
      <button
        className={`btn w-full justify-center ${side === 'buy' ? 'btn-primary' : 'btn-danger'}`}
        disabled={pending}
        type="submit"
      >
        {pending ? '…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${shares} share${shares === 1 ? '' : 's'}`}
      </button>
      {msg && <p className={`text-sm ${msg.startsWith('Filled') ? 'up' : 'down'}`}>{msg}</p>}
    </form>
  );
}
