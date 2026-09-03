# Mesa de Câmbio

Painel web de controle de câmbio (USD/BRL) por cliente, com resumo do dia.
Funciona em qualquer navegador (computador ou celular), sem precisar de login —
os dados ficam salvos num banco de dados na nuvem (PostgreSQL) e sincronizam
entre todos os aparelhos que abrirem o link.

## Rodar localmente

```bash
npm install
npm start
```

Abra http://localhost:3000. Sem a variável `DATABASE_URL`, os dados ficam
num arquivo local (`.local-data.json`) só para teste — não use isso em produção.

## Publicar de graça na nuvem (Render + Neon)

Passo a passo, sem precisar de cartão de crédito.

### 1. Criar o banco de dados (Neon)

1. Acesse https://neon.tech e crie uma conta gratuita (pode entrar com o Google).
2. Crie um novo projeto (qualquer nome, ex: `mesa-cambio`).
3. Na tela do projeto, copie a **Connection string** (algo como
   `postgresql://usuario:senha@ep-xxxxx.neon.tech/neondb?sslmode=require`).
   Guarde essa string — ela é a `DATABASE_URL`.

### 2. Subir o código para o GitHub

1. Acesse https://github.com e crie uma conta gratuita, se ainda não tiver.
2. Crie um repositório novo, vazio, por exemplo `mesa-cambio`.
3. Suba a pasta `mesa-cambio` (este projeto) para esse repositório — pode
   arrastar os arquivos pela interface do GitHub ("Add file" → "Upload files"),
   ou usar `git push` se preferir linha de comando.

### 3. Publicar no Render

1. Acesse https://render.com e crie uma conta gratuita (pode entrar com o GitHub).
2. Clique em **New +** → **Web Service**.
3. Conecte o repositório `mesa-cambio` que você criou no GitHub.
4. Confirme as configurações (o `render.yaml` já deixa pronto):
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
5. Em **Environment Variables**, adicione:
   - `DATABASE_URL` = a connection string que você copiou do Neon
6. Clique em **Deploy**. Em 1–2 minutos o Render mostra o link público, algo como
   `https://mesa-cambio.onrender.com` — esse é o link para abrir em qualquer
   computador ou celular, sem login.

### Observações

- O plano gratuito do Render "dorme" depois de alguns minutos sem uso; o
  primeiro acesso depois disso demora uns 30-60 segundos para acordar — os
  próximos são instantâneos.
- O banco do Neon é gratuito para sempre no plano free (não expira), com
  0,5 GB de espaço — mais do que suficiente para milhares de lançamentos.
- Para atualizar o site depois de mudanças no código, basta subir os novos
  arquivos para o GitHub — o Render publica de novo automaticamente.
