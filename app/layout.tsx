// Conversao piloto da fase TS-0 (ADR-007): prova end-to-end de que a
// configuracao TypeScript funciona no typecheck E no `next build`. Escolhido
// por ser o arquivo permanente de menor risco do repositorio — sem regra
// financeira, sem acesso a banco, sem dado externo, e nao importado por
// nenhuma suite `node:test`. Nenhum comportamento muda: o markup e o metadata
// sao identicos aos do `app/layout.js` anterior.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'TechLab+ Aldeia — ACASA',
  description: 'Sistema de Controle de Pagamentos ACASA',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
