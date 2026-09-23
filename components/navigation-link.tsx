'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './nav-bar.module.css'

type NavigationLinkProps = {
  href: string
  label: string
}

export function NavigationLink({ href, label }: NavigationLinkProps) {
  const pathname = usePathname()
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${styles.link} ${active ? styles.activeLink : ''}`}
    >
      {label}
    </Link>
  )
}
