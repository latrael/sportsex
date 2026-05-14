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
      <body className="min-h-screen bg-bg">
        <header className="sticky top-0 z-50 bg-panel border-b border-edge"
          style={{ boxShadow: '0 1px 3px 0 rgba(15,23,42,0.07)' }}>
          <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-6">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 10 L5 6 L8 8 L12 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="12" cy="3" r="1.2" fill="white"/>
                </svg>
              </div>
              <span className="font-bold text-base tracking-tight text-ink">sportsex</span>
            </Link>

            {/* Nav */}
            <nav className="hidden md:flex items-center gap-1 text-sm">
              {[
                { href: '/players', label: 'Players' },
                { href: '/teams', label: 'Teams' },
                { href: '/predictions', label: 'Predictions' },
                { href: '/leaderboard', label: 'Leaderboard' },
                { href: '/friends', label: 'Friends' },
                { href: '/quests', label: 'Quests' },
              ].map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className="px-3 py-1.5 rounded-lg text-mute font-medium hover:text-ink hover:bg-panel2 transition-all duration-100"
                >
                  {label}
                </Link>
              ))}
            </nav>

            {/* Right side */}
            <div className="ml-auto flex items-center gap-2">
              {me ? (
                <>
                  <Link
                    href="/portfolio"
                    className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-panel2 transition-colors text-sm"
                  >
                    <span className="text-mute font-medium">@{me.handle}</span>
                    <span className="font-mono font-semibold text-accent text-xs px-2 py-0.5 bg-blue-50 border border-blue-100 rounded-md">
                      {me.coinBalance.toLocaleString()} <span className="text-blue-400">coins</span>
                    </span>
                  </Link>
                  <form action={async () => { 'use server'; await signOut({ redirectTo: '/' }); }}>
                    <button className="btn text-xs" type="submit">Sign out</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login" className="btn text-sm">Sign in</Link>
                  <Link href="/signup" className="btn btn-primary text-sm">Get started</Link>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-8">{children}</main>

        <footer className="border-t border-edge mt-16">
          <div className="max-w-7xl mx-auto px-4 py-6 flex items-center justify-between text-xs text-mute">
            <span className="font-semibold text-ink/40">sportsex</span>
            <span>Virtual currency only · not real money · EPL · v1</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
