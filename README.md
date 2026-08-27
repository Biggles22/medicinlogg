# Medicinlogg

En offline-first GitHub Pages-app för daglig medicinloggning. Data sparas först lokalt i webbläsaren (`localStorage`) och kan synkroniseras krypterat via HTTPS till användarens Supabase-konto. Ingen loggdata skickas till GitHub.

## Publicera på GitHub Pages

1. Skapa ett nytt GitHub-repo.
2. Lägg filerna i den här mappen i repot: `index.html`, `manifest.webmanifest`, `sw.js`, `icon.svg`.
3. Gå till repo-inställningar: **Settings -> Pages**.
4. Välj branch, vanligtvis `main`, och root-mappen.
5. Öppna Pages-länken på iPhone i Safari.
6. Tryck på dela-knappen och välj **Lägg till på hemskärmen**.

## Standarddag i appen

Mallen är förifylld med:

- 07:00: Madopark 200 mg, Entacapone 200 mg, Plåster 4 mg, Atorbir 10 mg
- 10:00: Madopark 200 mg, Entacapone 200 mg
- 13:00: Madopark 200 mg, Entacapone 200 mg
- 16:00: Madopark 200 mg, Entacapone 200 mg
- 19:00: Madopark 200 mg, Entacapone 200 mg

Du kan ändra mallen i fliken **Standarddag**. På fliken **Dag** kan du skapa dagens rader från mallen och sedan justera planerad tid, faktisk intagstid, dos eller anteckning för just den dagen.

## Säkerhetskopia

**Excel-rapport** skapar en läsbar rapport för uppföljning. **Säkerhetskopia** sparar däremot en JSON-fil som senare kan läsas tillbaka med **Slå ihop backup**. Importen sammanfogar stabila post-ID:n och behåller den senast ändrade versionen i stället för att ersätta hela historiken.

Appens gränssnitt cachas lokalt efter första besöket och kan därefter öppnas utan internetanslutning.

## Säker molnsynk och PS Medicinkoll

Projektet innehåller nu en Supabase-backend som kan driftsättas separat. PWA:n sparar fortfarande först i `localStorage`, köar ändringar och synkroniserar i båda riktningarna vid nätanslutning, appstart och när appen blir aktiv. Stabilt lokalt ID används som `client_record_id`, den senast ändrade versionen vinner vid konflikt och tombstones hindrar offline-enheter från att återuppliva raderade poster.

GPT-ytan definieras i `openapi.yaml` och innehåller endast tre GET-operationer:

- `medication-context` för högst 31 dagars detaljdata (sju dagar som standard)
- `medication-summary` för högst 366 dagars matematisk statistik
- `current-medications` för medicinering som kan utläsas ur de senaste loggarna

Detta är **inte driftsatt bara genom att filerna finns i repot**.

### Driftsättning

1. Skapa Supabase-projektet uttryckligen i Stockholm (`eu-north-1`).
2. Länka Supabase CLI och kör `supabase db push`.
3. Kör RLS-testet med `supabase test db tests/rls.sql`.
4. Driftsätt funktionerna i `supabase/functions`.
5. Aktivera e-post/OTP och lägg till GitHub Pages-adressen som tillåten redirect-URL.
6. Kopiera `config.example.js` till deploymentens `config.js` och ange endast projekt-URL och publik/publishable key. Lägg aldrig in service-role key eller annan hemlighet i GitHub Pages.
7. Sätt bryggans `GPT_OAUTH_*`-värden som Supabase Edge Function Secrets. Client Secret får aldrig ligga i repot.
8. Validera `openapi.yaml` och importera det i GPT-editorn. Ange bryggans Client ID/Secret där, aldrig i PWA:n eller repot.
9. Verifiera authorize, consent, engångskod, tokenrotation och återkallning med `tests/bridge_qa.mjs`.
10. Slutför alla markerade delar i integritetspolicyn och genomför GDPR-/DPIA-bedömning före verkliga hälsodata.

OAuth-adresser efter projektstart:

```text
Authorization: https://<project-ref>.supabase.co/functions/v1/oauth-authorize
Token:         https://<project-ref>.supabase.co/functions/v1/oauth-token
API:           https://<project-ref>.supabase.co/functions/v1
```

Bryggan behövs eftersom GPT Actions OAuth-flöde inte skickar PKCE-parametrarna som Supabase OAuth 2.1 Server kräver. Bryggan utfärdar egna opaka read-only-token. Endast SHA-256-hashar lagras; användaridentiteten löses server-side och samtliga hälsodatafrågor filtreras explicit på den användaren.

### Kontroller

Kör `node tests/static_checks.mjs`, `node tests/timezone_checks.mjs` och `node tests/sync_merge_checks.mjs`. Databastestet kontrollerar uttryckligen att användare A inte kan läsa användare B:s doser eller observationer. `tests/remote_qa.mjs` verifierar även idempotens och att en gammal enhet inte kan återuppliva en raderad post. `tests/bridge_qa.mjs` kör ett fullständigt syntetiskt OAuth-flöde mot det länkade testprojektet och kräver att bridge-hemligheten tillförs enbart som processmiljö.

Före produktion återstår dessutom verifiering av två riktiga testkonton, offline/online-scenariot med exakt tre poster, OAuth-återkallning, konto- och backuppruning samt ett datumintervall över CET/CEST-skifte.
