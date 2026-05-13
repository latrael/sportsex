'use client';
import { useState, useTransition } from 'react';

export default function ReportButton({ commentId }: { commentId: number }) {
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function report() {
    start(async () => {
      const res = await fetch(`/api/comments/${commentId}/report`, { method: 'POST' });
      if (res.ok) setDone(true);
    });
  }

  if (done) return <span className="text-xs text-mute">Reported</span>;

  return (
    <button
      className="text-xs text-mute hover:text-warn transition-colors"
      onClick={report}
      disabled={pending}
    >
      {pending ? '…' : 'Report'}
    </button>
  );
}
