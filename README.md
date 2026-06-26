# FlightHeat ✈

Live flight heatmap dashboard powered by the [OpenSky Network](https://opensky-network.org) API.

## Quick start

```bash
git clone <repo-url>
cd flight-heat-map
docker compose up --build
```

Open **http://localhost:3000** in your browser.

## OpenSky account (optional)

Anonymous access allows **400 requests/day**. A free registered account raises this to **4000 requests/day**.

1. Register at https://opensky-network.org (free)
2. Set credentials in `docker-compose.yml`:

```yaml
environment:
  - OPENSKY_USER=your_username
  - OPENSKY_PASS=your_password
```

Or pass them at runtime:

```bash
OPENSKY_USER=you OPENSKY_PASS=secret docker compose up
```

## Heatmap layers

| Layer | Colour scale | What it shows |
|-------|-------------|---------------|
| **Gęstość** | cyan → orange → red | Number of aircraft per area |
| **Wysokość** | dark blue → cyan → white | Altitude (normalised to 13 000 m) |
| **Prędkość** | dark purple → magenta → pink | Ground speed (normalised to 1 000 m/s) |

Switch layers with the buttons in the top bar.

## Presets

| Name | Area |
|------|------|
| Polska | Poland |
| Europa Środkowa | Central Europe |
| Trójmiasto | Gdańsk / Gdynia / Sopot area |
| Europa | Broad European view |

## Rate limits

| Access | Requests/day |
|--------|-------------|
| Anonymous | 400 |
| Registered (free) | 4 000 |

Responses are cached server-side for **15 seconds** per bounding box to avoid burning quota on rapid refreshes.

## Baza danych samolotów

Aby włączyć identyfikację samolotów (rejestracja, producent, model, linia lotnicza), pobierz i zaimportuj bezpłatną bazę OpenSky (~500 tys. wpisów):

```bash
# Po pierwszym uruchomieniu docker compose up:
docker compose exec flightheat node scripts/import-aircraft-db.js
```

Lub lokalnie (poza Dockerem):

```bash
node scripts/import-aircraft-db.js
# Import zajmuje ~30 sekund. Dane są zapisywane do ./data/flightheat.db
```

Po imporcie kliknięcie samolotu w mapie wyświetli pełną kartę z rejestracją, typem maszyny, operatorem i zdjęciem z planespotters.net.

Zdjęcia są cachowane w pamięci przez **1 godzinę** po pierwszym pobraniu.
