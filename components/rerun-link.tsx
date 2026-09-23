'use client'

type Props = {
  systemName: string
  systemId?: string | null
  rerunFrom: string
  className?: string
  children: React.ReactNode
}

export function RerunLink({ systemName, systemId, rerunFrom, className, children }: Props) {
  const href = (() => {
    const query = new URLSearchParams({ rerunFrom })
    if (systemName) query.set('systemName', systemName)
    if (systemId) query.set('systemId', systemId)
    return `/analyze?${query.toString()}`
  })()

  return (
    <a
      href={href}
      className={className}
    >
      {children}
    </a>
  )
}
