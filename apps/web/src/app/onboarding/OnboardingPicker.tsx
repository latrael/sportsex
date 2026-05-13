'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Player = {
  id: number;
  fullName: string;
  posBucket: string | null;
  teamName: string;
  goals: number;
  assists: number;
  price: number;
};

export default function OnboardingPicker({ players }: { players: Player[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 3) {
        next.add(id);
      }
      return next;
    });
  }

  function submit() {
    setMsg(null);
    start(async () => {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds: Array.from(selected) }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.error === 'already_completed') {
          router.replace('/');
          return;
        }
        setMsg(j.error ?? 'Something went wrong');
        return;
      }
      router.replace('/?onboarded=1');
    });
  }

  const count = selected.size;

  return (
    <div className="space-y-6">
      <div className="text-sm text-mute">
        {count < 3 ? (
          <span>Pick {3 - count} more player{3 - count !== 1 ? 's' : ''} to continue</span>
        ) : (
          <span className="up">3 players selected — ready to go!</span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {players.map((p) => {
          const isSelected = selected.has(p.id);
          const isDisabled = !isSelected && count >= 3;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              disabled={isDisabled}
              className={`card text-left transition-all cursor-pointer ${
                isSelected
                  ? 'border-accent bg-emerald-900/20'
                  : isDisabled
                  ? 'opacity-40 cursor-not-allowed'
                  : 'hover:border-accent/60'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket ?? '?'}</span>
                <span className="font-medium text-sm">{p.fullName}</span>
                {isSelected && <span className="ml-auto text-accent text-lg">✓</span>}
              </div>
              <div className="text-xs text-mute">{p.teamName}</div>
              <div className="text-xs text-mute mt-1">{p.goals}G · {p.assists}A · {p.price.toFixed(0)} coins</div>
            </button>
          );
        })}
      </div>

      <button
        className="btn btn-primary"
        disabled={count < 3 || pending}
        onClick={submit}
      >
        {pending ? 'Setting up…' : 'Continue (+500 coins)'}
      </button>

      {msg && <p className="text-sm down">{msg}</p>}
    </div>
  );
}
