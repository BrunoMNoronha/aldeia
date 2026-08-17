'use strict';

/**
 * Configuracao do Next.js (Fase NX-0).
 *
 * `poweredByHeader: false` preserva a postura que o Express ja adotava com
 * `app.disable('x-powered-by')`: a aplicacao nao anuncia a tecnologia que a
 * serve. Sem esta linha o Next envia `X-Powered-By: Next.js` em toda resposta.
 *
 * `serverExternalPackages` NAO e declarado: `better-sqlite3` ja consta na lista
 * interna do Next 16 (`server-external-packages.jsonc`), portanto o modulo
 * nativo ja fica fora do bundle sem configuracao nenhuma. Declarar de novo seria
 * repetir um default e sugerir, falsamente, que ha algo especial a configurar.
 *
 * `outputFileTracingExcludes` impede que o BANCO REAL entre no output do servidor.
 * `DEFAULT_DB_PATH` em `src/config.js` e um caminho estatico
 * (`path.join(ROOT_DIR, 'data', 'acasa.sqlite')`), entao o rastreador do Next o
 * resolve, encontra o arquivo em disco e o inclui como dependencia da rota — foi
 * exatamente o que a revisao NX-0R observou no `.nft.json` de `/health`. `data/`
 * guarda dado de producao, e nao artefato de build: nunca deve ser copiado para
 * o output. Isto NAO altera como o banco e resolvido em tempo de execucao.
 *
 * Nada alem disso e definido de proposito: T-03 exige que a aplicacao rode sem
 * servico externo, e nada aqui deve introduzir dependencia de plataforma.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingExcludes: {
    '**/*': ['./data/**/*'],
  },
};

module.exports = nextConfig;
