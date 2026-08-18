# Medicinlogg

En statisk GitHub Pages-app för daglig medicinloggning. All personlig data sparas lokalt i webbläsaren (`localStorage`) och skickas inte till GitHub.

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

**Excel-rapport** skapar en läsbar rapport för uppföljning. **Säkerhetskopia** sparar däremot en JSON-fil som senare kan läsas tillbaka med **Återställ**. Spara regelbundet JSON-filen på en säker plats eftersom webbläsarens lokala data kan rensas.

Appens gränssnitt cachas lokalt efter första besöket och kan därefter öppnas utan internetanslutning.
