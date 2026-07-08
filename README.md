# Bird Spotter Ireland

A static, public web page that shows bird occurrence records in Ireland using the GBIF Occurrence API.

## What it does

- Shows an interactive Ireland map.
- Defaults the date picker to today.
- Requests Ireland bird records from GBIF for the selected date.
- Places each geolocated sighting on the map.
- Groups sightings by bird in a side list.
- Shows a counter for sightings per bird.
- Filters the map when a bird is selected.

## Data source

Bird sighting data comes from the public GBIF Occurrence API:

```text
https://api.gbif.org/v1/occurrence/search
```

The page uses browser-side requests only. There are no accounts, API keys, or server-side secrets.

## Deployment

This site is ready for GitHub Pages. Publish the repository and set GitHub Pages to serve from the repository root.
