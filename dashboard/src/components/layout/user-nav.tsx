'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { User } from '@supabase/supabase-js';

export function UserNav() {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then((res: { data: { user: User | null } }) => setUser(res.data.user));
  }, []);

  const email = user?.email ?? '';
  const initials = email.slice(0, 2).toUpperCase();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <div className="flex items-center gap-3">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="bg-brand-primary text-white text-xs font-semibold">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white truncate">{email}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-white/60 hover:text-white hover:bg-white/10 shrink-0"
        onClick={handleSignOut}
        title="Sign out"
      >
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
