import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WorkOffice — Escritorio Interativo de Agentes de IA',
  description:
    'Orquestracao, observabilidade e representacao visual isometrica retro de agentes de IA.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
