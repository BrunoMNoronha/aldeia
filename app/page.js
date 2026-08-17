// Pagina inicial minima da Fase NX-0: existe para comprovar que o Next.js esta
// servindo a aplicacao. Nenhuma consulta ao banco e nenhuma regra de dominio
// aqui — o redesenho das telas pertence a NX-2.

export default function Home() {
  return (
    <main>
      <h1>TechLab+ Aldeia</h1>
      <p>Sistema de Controle de Pagamentos ACASA</p>
      <p>
        Fundacao Next.js (NX-0). Verificacao de saude: <a href="/health">/health</a>.
      </p>
      <p>
        As telas operacionais de associados ainda respondem pelo servidor Express
        (<code>npm run start:express</code>) e serao migradas em NX-2.
      </p>
    </main>
  );
}
