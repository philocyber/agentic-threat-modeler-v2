import Link from 'next/link'
import Image from 'next/image'
import { NavigationLink } from '@/components/navigation-link'
import { ServiceHealthIndicator } from '@/components/service-health'
import { ActiveProjectSwitcher } from '@/components/active-project-switcher'
import styles from './nav-bar.module.css'

const NAVIGATION = [
  { href: '/', label: 'Analyses' },
  { href: '/analyze', label: 'Run analysis' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/docs', label: 'Documentation' },
] as const

export default function NavBar() {
  return (
    <nav aria-label="Primary navigation" className="relative z-50 border-b border-[#dfe5dc] bg-white/95 text-[#111111] backdrop-blur-sm lg:sticky lg:top-0">
      <div className={`${styles.inner ?? ''} mx-auto flex max-w-[1600px] items-center gap-3 px-4 lg:px-8`}>
        <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="Argus analyses">
          <Image src="/brand/argus-wordmark.svg" width={440} height={100} alt="Argus" className={styles.logo ?? ''} priority />
        </Link>

        <ActiveProjectSwitcher />

        <div className={`${styles.desktopLinks ?? ''} gap-1`}>
          {NAVIGATION.map((item) => <NavigationLink key={item.href} {...item} />)}
        </div>

        <div className={styles.serviceWrap ?? ''}><ServiceHealthIndicator /></div>
        <details className={`${styles.mobileMenu ?? ''} relative shrink-0`}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center rounded-full border border-[#d6dfd3] px-3 text-xs font-semibold text-[#26362a] marker:content-none">Menu</summary>
          <div className="absolute right-0 top-full z-50 mt-2 grid min-w-44 gap-1 rounded-2xl border border-[#d6dfd3] bg-white p-2 shadow-[0_10px_28px_rgba(44,40,43,0.12)]">
            {NAVIGATION.map((item) => <NavigationLink key={item.href} {...item} />)}
          </div>
        </details>
      </div>
    </nav>
  )
}
