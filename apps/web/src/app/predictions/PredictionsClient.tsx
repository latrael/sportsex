'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Match = {
  id: number;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  status: string;
  alreadyPredicted: boolean;
  odds: {
    H: number;
    D: number;
    A: number;
  };
};

type Prediction = {
  id: number;
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  pick: string;
  coinsStaked: number;
  odds?: number;
  resolved: boolean;
  payout: number;
  createdAt: string;
};

function PredictForm({ match, balance, onDone }: { match: Match; balance: number; onDone: () => void }) {
  const [pick, setPick] = useState<'H' | 'D' | 'A'>('H');
  const [stake, setStake] = useState(100);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const currentOdds = match.odds?.[pick] ?? 2.0;
  const estPayout = Math.round(stake * currentOdds);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const res = await fetch('/api/predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: match.id, pick, coinsStaked: stake }),
      });
      const j = await res.json();
      if (!res.ok) {
        const errMap: Record<string, string> = {
          already_predicted: 'You already have a prediction for this match.',
          insufficient_funds: 'Not enough coins.',
          match_not_open: 'Match is no longer open for predictions.',
        };
        setMsg(errMap[j.error] ?? j.error);
        return;
      }
      setMsg(`Prediction placed: ${pick} @ ${currentOdds.toFixed(2)}× · ${stake} coins staked`);
      onDone();
    });
  }

  const pickLabels = {
    H: `${match.homeTeam} (${match.odds.H.toFixed(2)}×)`,
    D: `Draw (${match.odds.D.toFixed(2)}×)`,
    A: `${match.awayTeam} (${match.odds.A.toFixed(2)}×)`,
  };

  return (
    <form onSubmit={submit} className="space-y-3 mt-3 pt-3 border-t border-edge">
      <div className="flex gap-2">
        {(['H', 'D', 'A'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPick(p)}
            className={`btn flex-1 justify-center text-xs ${pick === p ? 'btn-primary' : ''}`}
          >
            {pickLabels[p]}
          </button>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <label className="text-xs text-mute shrink-0">Stake</label>
        <input
          className="input"
          type="number"
          min={10}
          max={Math.min(10000, balance)}
          value={stake}
          onChange={(e) => setStake(Math.max(10, parseInt(e.target.value || '10', 10)))}
        />
        <span className="text-xs text-mute shrink-0">coins (balance: {balance.toLocaleString()})</span>
      </div>
      <div className="text-xs text-mute">
        Correct prediction pays <span className="up">{currentOdds.toFixed(2)}×</span> ({estPayout.toLocaleString()} coins).
      </div>
      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? '…' : `Predict: ${pick} @ ${currentOdds.toFixed(2)}× · ${stake} coins`}
      </button>
      {msg && <p className={`text-xs ${msg.startsWith('Prediction placed') ? 'up' : 'down'}`}>{msg}</p>}
    </form>
  );
}

export default function PredictionsClient({
  balance,
  matches,
  predictions,
}: {
  balance: number;
  matches: Match[];
  predictions: Prediction[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const router = useRouter();

  function handleDone() {
    setOpenId(null);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold mb-1">Predictions</h1>
        <p className="text-mute text-sm">
          Stake coins on match results with live Poisson odds derived from club attack and defence strength.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Upcoming matches</h2>
        {matches.length === 0 ? (
          <div className="card text-mute text-sm">
            <p>No scheduled matches right now.</p>
            <p className="mt-1">Upcoming Premier League fixtures will appear here when scheduled.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {matches.map((m) => (
              <div key={m.id} className="card">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{m.homeTeam} <span className="text-mute">vs</span> {m.awayTeam}</div>
                    <div className="text-xs text-mute">
                      {new Date(m.kickoffAt).toLocaleString()} · <span className="chip">{m.status}</span>
                      {' · '}
                      <span className="font-mono">
                        H {m.odds.H.toFixed(2)}× / D {m.odds.D.toFixed(2)}× / A {m.odds.A.toFixed(2)}×
                      </span>
                    </div>
                  </div>
                  {m.alreadyPredicted ? (
                    <span className="text-xs up">Predicted ✓</span>
                  ) : (
                    <button
                      className={`btn ${openId === m.id ? '' : 'btn-primary'}`}
                      onClick={() => setOpenId(openId === m.id ? null : m.id)}
                    >
                      {openId === m.id ? 'Cancel' : 'Predict'}
                    </button>
                  )}
                </div>
                {openId === m.id && !m.alreadyPredicted && (
                  <PredictForm match={m} balance={balance} onDone={handleDone} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Your predictions</h2>
        {predictions.length === 0 ? (
          <p className="text-mute text-sm">No predictions yet.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="t">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Pick</th>
                  <th className="text-right">Odds</th>
                  <th className="text-right">Staked</th>
                  <th>Status</th>
                  <th className="text-right">Payout</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => (
                  <tr key={p.id}>
                    <td className="text-sm">{p.homeTeam} vs {p.awayTeam}</td>
                    <td>
                      <span className="chip">
                        {p.pick === 'H' ? `${p.homeTeam} win` : p.pick === 'A' ? `${p.awayTeam} win` : 'Draw'}
                      </span>
                    </td>
                    <td className="text-right font-mono">{(p.odds ?? 2.0).toFixed(2)}×</td>
                    <td className="text-right font-mono">{p.coinsStaked}</td>
                    <td>
                      {p.resolved ? (
                        p.payout > 0 ? <span className="up text-xs">Won</span> : <span className="down text-xs">Lost</span>
                      ) : (
                        <span className="text-mute text-xs">Pending</span>
                      )}
                    </td>
                    <td className="text-right font-mono">
                      {p.resolved ? (
                        <span className={p.payout > 0 ? 'up' : 'down'}>
                          {p.payout > 0 ? `+${p.payout}` : '0'}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
