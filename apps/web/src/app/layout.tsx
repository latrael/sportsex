import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { auth, signOut } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'sportsex',
  description: 'Invest in players and teams. Validate your sports takes.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const me = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-edge bg-panel/80 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
            <Link href="/" className="font-bold text-xl text-accent">sportsex</Link>
            <nav className="flex items-center gap-4 text-sm text-mute">
              <Link href="/players" className="hover:text-ink">Players</Link>
              <Link href="/teams" className="hover:text-ink">Teams</Link>
              <Link href="/portfolio" className="hover:text-ink">Portfolio</Link>
              <Link href="/leaderboard" className="hover:text-ink">Leaderboard</Link>
              <Link href="/friends" className="hover:text-ink">Friends</Link>
              <Link href="/predictions" className="hover:text-ink">Predictions</Link>
              <Link href="/quests" className="hover:text-ink">Quests</Link>
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              {me ? (
                <>
                  <span className="text-mute">@{me.handle}</span>
                  <span className="chip">{me.coinBalance.toLocaleString()} coins</span>
                  <form action={async () => { 'use server'; await signOut({ redirectTo: '/' }); }}>
                    <button className="btn" type="submit">Sign out</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login" className="btn">Sign in</Link>
                  <Link href="/signup" className="btn btn-primary">Sign up</Link>
                </>
              )}
            </div>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
        <footer className="max-w-6xl mx-auto px-4 py-8 text-xs text-mute">
          sportsex v1 · virtual currency · not real money · EPL only
        </footer>
      </body>
    </html>
  );
}
