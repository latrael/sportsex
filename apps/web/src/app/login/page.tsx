import { signIn } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage({ searchParams }: { searchParams?: { error?: string } }) {
  async function login(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    try {
      await signIn('credentials', { email, password, redirectTo: '/' });
    } catch (e) {
      // NextAuth throws a redirect — propagate
      if ((e as { digest?: string })?.digest?.startsWith('NEXT_REDIRECT')) throw e;
      redirect('/login?error=invalid');
    }
  }
  return (
    <div className="max-w-sm mx-auto card">
      <h1 className="text-xl font-semibold mb-4">Sign in</h1>
      {searchParams?.error && <p className="text-danger text-sm mb-3">Invalid credentials.</p>}
      <form action={login} className="space-y-3">
        <input className="input" name="email" type="email" placeholder="Email" required />
        <input className="input" name="password" type="password" placeholder="Password" required />
        <button className="btn btn-primary w-full justify-center" type="submit">Sign in</button>
      </form>
      <p className="text-sm text-mute mt-4">No account? <Link className="text-accent" href="/signup">Sign up</Link></p>
    </div>
  );
}
