import { redirect } from 'next/navigation';

// Root → /agents (the dashboard's default landing page).
// Middleware handles the unauthenticated case (redirect to /login).
export default function RootPage() {
  redirect('/agents');
}
