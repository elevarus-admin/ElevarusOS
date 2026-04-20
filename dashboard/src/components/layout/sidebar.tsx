'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Calendar, Clock, Bot, GitBranch, Settings, BarChart2, Plug, Code2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UserNav } from './user-nav';

const NAV_ITEMS = [
  { href: '/active',        label: 'Active Jobs',    icon: Activity },
  { href: '/scheduled',     label: 'Scheduled',      icon: Calendar },
  { href: '/history',       label: 'Job History',    icon: Clock },
  { href: '/agents',        label: 'Agents',         icon: Bot },
  { href: '/workflows',     label: 'Workflows',      icon: GitBranch },
  { href: '/tokens',        label: 'Token Usage',    icon: BarChart2 },
  { href: '/integrations',  label: 'Integrations',   icon: Plug },
  { href: '/api-reference', label: 'API Reference',  icon: Code2 },
  { href: '/settings',      label: 'Settings',       icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-brand-sidebar">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-white/10">
        <img
          src="https://elevarus.com/wp-content/uploads/2023/12/elevarus-logo.webp"
          alt="Elevarus"
          className="h-8 w-auto"
        />
        <div className="text-white">
          <div className="text-sm font-semibold leading-none">ElevarusOS</div>
          <div className="text-xs text-white/60 mt-0.5">Dashboard</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-primary text-white'
                  : 'text-white/80 hover:bg-white/10 hover:text-white'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="border-t border-white/10 p-4">
        <UserNav />
      </div>
    </aside>
  );
}
