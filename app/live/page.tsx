import type { Metadata } from 'next';
import { LivePanel } from '@/components/LivePanel';

export const metadata: Metadata = {
  title: 'MT5 bridge live monitor',
  description: 'What the MetaTrader 5 Expert Advisor is being told to do (demo accounts only)',
};

export default function LivePage() {
  return <LivePanel />;
}
