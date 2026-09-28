# Lessons

## 2026-09-28 — Tussenoplossing niet presenteren als de oplossing
- **Fout:** na de deploy gaf ik "sites toevoegen via de CLI" als volgende stap, terwijl de gebruiker expliciet sites via het dashboard wil beheren. Het dashboard was bewust naar een volgende ronde geschoven, maar dat stond niet duidelijk in de afronding.
- **Regel:** als een gevraagde feature (nog) niet gebouwd is, zeg dat expliciet bovenaan ("het dashboard bestaat nog niet"). Label een tussenoplossing als tijdelijk of noodroute, en stel de feature zelf voor als volgende stap.
- **Regel:** geef bij elke gegenereerde secret aan wie hem gebruikt en waar hij moet worden ingevuld, niet alleen "bewaar hem".

## 2026-09-28 — Formulieren met credentials van derden
- **Fout:** het siteformulier gebruikte veldnamen `username`/`password`; de browser/password manager vulde daar bij elke bewerking de eigen login ("admin") in, waardoor de WordPress-koppeling brak.
- **Regel:** velden voor credentials van *andere* systemen nooit `username`/`password` noemen; gebruik neutrale namen (`wp_user`, `app_password`), `autocomplete="off"`/`new-password` plus `data-1p-ignore data-lpignore data-bwignore`, en toon bij bewerken de opgeslagen waarde zodat een ingevulde afwijking opvalt.
