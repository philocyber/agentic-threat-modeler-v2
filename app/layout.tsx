import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { connection } from 'next/server'
import NavBar from '@/components/nav-bar'
import './globals.css'
import './design-v2.css'

const inter = localFont({
  src: [
    { path: './fonts/Inter-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/Inter-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/Inter-SemiBold.ttf', weight: '600', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
})

const archivo = localFont({
  src: [
    { path: './fonts/Archivo-SemiBold.ttf', weight: '600', style: 'normal' },
    { path: './fonts/Archivo-Bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-archivo',
  display: 'swap',
})

const jetBrainsMono = localFont({
  src: [
    { path: './fonts/JetBrainsMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/JetBrainsMono-Medium.ttf', weight: '500', style: 'normal' },
  ],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Argus | PhiloCyber',
  description: 'A PhiloCyber workspace for traceable, evidence-led threat modeling.',
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The request CSP supplies a fresh nonce; prerendered scripts cannot use it.
  await connection()
  return (
    <html lang="en" data-theme="ledger" className={`${inter.variable} ${archivo.variable} ${jetBrainsMono.variable}`}>
      <body data-design-seed="philocyber-monochrome-intelligence">
        <div className="app-grid min-h-screen">
          <NavBar />
          <main className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
