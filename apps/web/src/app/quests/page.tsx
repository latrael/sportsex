'use client';
import { useEffect, useState, useTransition } from 'react';

type Quest = {
  id: number;
  code: string;
  title: string;
  body: string;
  rewardCoins: number;
  repeatKind: string;
  completedToday: boolean;
  completedEver: boolean;
  canClaim: boolean;
};

export default function QuestsPage() {
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  async function loadQuests() {
    const res = await fetch('/api/quests');
    if (res.ok) setQuests(await res.json());
    setLoading(false);
  }

  useEffect(() => { loadQuests(); }, []);

  function claim(code: string) {
    start(async () => {
      const res = await fetch('/api/quests/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const j = await res.json();
      if (res.ok) {
        setMsgs((m) => ({ ...m, [code]: `+${j.coinsGranted} coins claimed!` }));
        loadQuests();
      } else {
        const errMap: Record<string, string> = {
          already_completed: 'Already completed.',
          already_claimed_today: 'Already claimed today.',
          no_trade_today: 'Place a trade first.',
          no_comment_today: 'Post a comment first.',
          use_onboarding_flow: 'Complete via onboarding.',
        };
        setMsgs((m) => ({ ...m, [code]: errMap[j.error] ?? j.error }));
      }
    });
  }

  if (loading) return <p className="text-mute">Loading quests…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Quests</h1>
      <p className="text-mute text-sm">Complete quests to earn bonus coins. Daily quests reset at midnight.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {quests.map((q) => {
          const isDone = q.repeatKind === 'one_shot' ? q.completedEver : q.completedToday;
          const msg = msgs[q.code];
          return (
            <div key={q.id} className={`card space-y-2 ${isDone ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{q.title}</div>
                  <div className="text-sm text-mute">{q.body}</div>
                </div>
                <span className="chip text-accent border-accent/40 whitespace-nowrap">
                  +{q.rewardCoins} coins
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="chip">{q.repeatKind}</span>
                {isDone ? (
                  <span className="text-xs up">Completed ✓</span>
                ) : q.canClaim ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => claim(q.code)}
                    disabled={pending}
                  >
                    Claim
                  </button>
                ) : (
                  <span className="text-xs text-mute">Complete the task first</span>
                )}
              </div>
              {msg && (
                <p className={`text-xs ${msg.startsWith('+') ? 'up' : 'down'}`}>{msg}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
