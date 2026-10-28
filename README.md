# MK9 Tarefas

Gestão de tarefas da Criação MK9, no estilo ClickUp, seguindo o design system da MK9.

## O que tem

- **Contas**: cada pessoa cria a própria conta (nome, e-mail e senha). A primeira conta vira administradora.
- **Espaços e listas**: um espaço por cliente, área ou campanha, com quantas listas precisar.
- **Três visões**: Lista (agrupada por status), Quadro (kanban com arrastar e soltar) e Calendário (arraste para mudar o prazo).
- **Tarefas completas**: status, responsáveis, datas de início e prazo, prioridade, etiquetas, descrição, subtarefas, checklist e anexos (até 25 MB, com prévia de imagens).
- **Comentários e atividade**: histórico de tudo que mudou e comentários com @menções.
- **Caixa de entrada**: avisos de atribuição, menção, comentário e mudança de status.
- **Minhas tarefas** e **Início** com atrasadas, de hoje e da semana.
- **Status editáveis por lista** (ex.: A fazer → Em produção → Em revisão → Aprovação cliente → Concluído).
- **Busca** com Ctrl+K, filtros por responsável e prioridade, ordenação e favoritos.
- **Tempo real**: o que uma pessoa muda aparece na tela das outras sem recarregar.
- **Equipe**: administradores podem promover pessoas ou desativar acessos.

Tudo fica salvo no banco de dados do servidor (SQLite) e os anexos numa pasta ao lado.

## Rodar no computador

Precisa do [Node.js 22.5 ou mais novo](https://nodejs.org). Não há dependências para instalar.

```bash
npm start
# abra http://localhost:3000
```

## Configuração

| Variável | Para que serve | Padrão |
|---|---|---|
| `PORT` | Porta do servidor | `3000` |
| `DATA_DIR` | Pasta do banco e dos anexos. **Precisa ser um disco persistente em produção.** | `./data` |
| `COOKIE_SECURE` | `true` quando o site roda em HTTPS | `false` |
| `REGISTRATION_CODE` | Se definido, só cria conta quem souber esse código | vazio |
| `ALLOWED_EMAIL_DOMAIN` | Se definido (ex.: `mk9.com.br`), só aceita e-mails desse domínio | vazio |

## Publicar

### Render (recomendado)

1. Em [render.com](https://render.com), escolha **New > Blueprint** e conecte este repositório. O arquivo `render.yaml` já configura tudo, inclusive um disco de 5 GB em `/var/data`.
2. Preencha `REGISTRATION_CODE` e/ou `ALLOWED_EMAIL_DOMAIN` para que só a equipe consiga se cadastrar.
3. O plano precisa ter disco persistente (Starter ou acima). Sem disco, os dados somem a cada deploy.

### Railway, Fly.io ou servidor próprio

Use o `Dockerfile` e monte um volume em `/data`.

## Design system

As cores, fontes, espaçamentos e raios estão em `public/css/tokens.css`. Para ajustar a marca, troque os valores ali; o resto do app só usa essas variáveis. A fonte da marca (arcadia) cai para Inter quando não está instalada.

## Backup

Copie a pasta `DATA_DIR` (arquivo `mk9.db` e pasta `uploads/`).
