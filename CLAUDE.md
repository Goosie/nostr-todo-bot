# Nostr TODO Bot — Goosie Labs V-Formatie

## Doel & Gebruik

**Nostr-native TODO management voor de flock.** 

Alle ganzen kunnen TODOs aanmaken als mentions naar `@Toddy`. Toddy verwerkt ze, slaat ze op in SQLite, en publiceert responses. Perry ziet alles. Toddy maakt overzichten per gans of globaal. Dit is het brein van gedeelde taken in de V-Formatie.

Voorbeeld flow:
```
[Finny] @Toddy add Zaptune refactoring 
→ Toddy: "TODO #42 aangemaakt voor Finny"
→ Slaat op in DB
→ Perry kan alle TODOs zien via /apps/swarm of via direct query
```

## Setup (Lokaal)

**Niet Cloudflare Workers** — dit draait als systemd service op `/home/deploy/nostr-todo-bot`.

- **Database:** SQLite (local file, eenvoudiger dan D1)
- **Trigger:** Via Blocky (NIP-90) of direct relay monitoring
- **Gans:** Toddy (`agents/toddy/nostr-key.json`)
- **Relay:** relay.goosielabs.com

## Actuele Stappen

1. **Toddy gans checken** — moet al bestaan (`agents/toddy/`)
2. **Bot code omzetten** — van Cloudflare Workers (wrangler) naar Node.js
3. **Database schema** — SQLite in plaats van D1
4. **Systemd service** — `/etc/systemd/system/nostr-todo-bot.service`
5. **Blocky scheduling** — optioneel, of direct relay monitoring
6. **Deploy & testen**

## Broncode

- Origineel: https://github.com/mattn/nostr-todo-bot (Cloudflare Workers)
- Aanpassingen: Node.js version, SQLite, systemd

## Details nog in te vullen

- [ ] Toddy gans configured
- [ ] Node.js refactor klaar
- [ ] Database schema gemaakt
- [ ] Systemd service actief
- [ ] Blocky scheduling ingesteld
