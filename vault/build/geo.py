"""Geography for the persona facets: the survey's Country answer -> ISO2 -> region, and the names and demonyms a
profile's prose may use for a country (the consistency guard checks them against facets.country).

Three static maps, built from one table so they never drift apart:
  COUNTRY_ISO2   survey Country (Stack Overflow Developer Survey 2025 wording) -> ISO 3166-1 alpha-2
  ISO2_REGION    ISO2 -> region (REGIONS)
  NAME_ISO2      a name or demonym used in prose ("Canadian", "Swedish", "US") -> ISO2; matched case-sensitively

  python geo.py --ts > ../../src/geo-data.ts     # the same maps for the server (search filters, audience validation)
"""
import json, re, sys

REGIONS = ["north_america", "latam", "eu", "europe_other", "uk", "south_asia", "east_asia", "sea", "oceania", "mena", "africa"]

# survey name | ISO2 | region | other names and demonyms (comma separated). Central Asia and the Caucasus are grouped
# with europe_other (the survey's own regional split does the same); the Caribbean with latam.
_TABLE = """
Afghanistan|AF|south_asia|Afghan
Albania|AL|europe_other|Albanian
Algeria|DZ|mena|Algerian
Andorra|AD|europe_other|Andorran
Angola|AO|africa|Angolan
Antigua and Barbuda|AG|latam|Antiguan
Argentina|AR|latam|Argentine,Argentinian
Armenia|AM|europe_other|Armenian
Australia|AU|oceania|Australian
Austria|AT|eu|Austrian
Azerbaijan|AZ|europe_other|Azerbaijani
Bahrain|BH|mena|Bahraini
Bangladesh|BD|south_asia|Bangladeshi
Barbados|BB|latam|Barbadian
Belarus|BY|europe_other|Belarusian
Belgium|BE|eu|Belgian
Belize|BZ|latam|Belizean
Benin|BJ|africa|Beninese
Bhutan|BT|south_asia|Bhutanese
Bolivia|BO|latam|Bolivian
Bosnia and Herzegovina|BA|europe_other|Bosnian,Bosnia
Botswana|BW|africa|Botswanan
Brazil|BR|latam|Brazilian
Brunei Darussalam|BN|sea|Brunei,Bruneian
Bulgaria|BG|eu|Bulgarian
Burundi|BI|africa|Burundian
Cambodia|KH|sea|Cambodian
Cameroon|CM|africa|Cameroonian
Canada|CA|north_america|Canadian
Cape Verde|CV|africa|Cape Verdean
Chile|CL|latam|Chilean
China|CN|east_asia|Chinese
Colombia|CO|latam|Colombian
Congo, Republic of the...|CG|africa|Republic of the Congo
Costa Rica|CR|latam|Costa Rican
Croatia|HR|eu|Croatian
Cuba|CU|latam|Cuban
Cyprus|CY|eu|Cypriot
Czech Republic|CZ|eu|Czech,Czechia
Côte d'Ivoire|CI|africa|Ivorian,Ivory Coast
Democratic People's Republic of Korea|KP|east_asia|North Korean,North Korea
Democratic Republic of the Congo|CD|africa|Congolese,DR Congo
Denmark|DK|eu|Danish
Djibouti|DJ|africa|Djiboutian
Dominican Republic|DO|latam|
Ecuador|EC|latam|Ecuadorian
Egypt|EG|mena|Egyptian
El Salvador|SV|latam|Salvadoran
Estonia|EE|eu|Estonian
Ethiopia|ET|africa|Ethiopian
Fiji|FJ|oceania|Fijian
Finland|FI|eu|Finnish
France|FR|eu|French
Gabon|GA|africa|Gabonese
Gambia|GM|africa|Gambian
Georgia|GE|europe_other|
Germany|DE|eu|German
Ghana|GH|africa|Ghanaian
Greece|GR|eu|Greek
Guatemala|GT|latam|Guatemalan
Guinea|GN|africa|Guinean
Guinea-Bissau|GW|africa|Bissau-Guinean
Guyana|GY|latam|Guyanese
Haiti|HT|latam|Haitian
Honduras|HN|latam|Honduran
Hong Kong (S.A.R.)|HK|east_asia|Hong Kong
Hungary|HU|eu|Hungarian
Iceland|IS|europe_other|Icelandic
India|IN|south_asia|Indian
Indonesia|ID|sea|Indonesian
Iran, Islamic Republic of...|IR|mena|Iran,Iranian
Iraq|IQ|mena|Iraqi
Ireland|IE|eu|Irish
Isle of Man|IM|uk|Manx
Israel|IL|mena|Israeli
Italy|IT|eu|Italian
Jamaica|JM|latam|Jamaican
Japan|JP|east_asia|Japanese
Jordan|JO|mena|Jordanian
Kazakhstan|KZ|europe_other|Kazakh,Kazakhstani
Kenya|KE|africa|Kenyan
Kosovo|XK|europe_other|Kosovar
Kuwait|KW|mena|Kuwaiti
Kyrgyzstan|KG|europe_other|Kyrgyz
Lao People's Democratic Republic|LA|sea|Laos,Laotian
Latvia|LV|eu|Latvian
Lebanon|LB|mena|Lebanese
Lesotho|LS|africa|Basotho
Libyan Arab Jamahiriya|LY|mena|Libya,Libyan
Lithuania|LT|eu|Lithuanian
Luxembourg|LU|eu|Luxembourgish
Madagascar|MG|africa|Malagasy
Malawi|MW|africa|Malawian
Malaysia|MY|sea|Malaysian
Maldives|MV|south_asia|Maldivian
Mali|ML|africa|Malian
Malta|MT|eu|Maltese
Mauritania|MR|africa|Mauritanian
Mauritius|MU|africa|Mauritian
Mexico|MX|latam|Mexican
Micronesia, Federated States of...|FM|oceania|Micronesia,Micronesian
Moldova|MD|europe_other|Moldovan
Mongolia|MN|east_asia|Mongolian
Montenegro|ME|europe_other|Montenegrin
Morocco|MA|mena|Moroccan
Mozambique|MZ|africa|Mozambican
Myanmar|MM|sea|Burmese,Burma
Namibia|NA|africa|Namibian
Nepal|NP|south_asia|Nepali,Nepalese
Netherlands|NL|eu|Dutch,Holland
New Zealand|NZ|oceania|New Zealander
Nicaragua|NI|latam|Nicaraguan
Niger|NE|africa|Nigerien
Nigeria|NG|africa|Nigerian
North Korea|KP|east_asia|
Norway|NO|europe_other|Norwegian
Oman|OM|mena|Omani
Pakistan|PK|south_asia|Pakistani
Palau|PW|oceania|Palauan
Palestine|PS|mena|Palestinian
Panama|PA|latam|Panamanian
Papua New Guinea|PG|oceania|Papua New Guinean
Paraguay|PY|latam|Paraguayan
Peru|PE|latam|Peruvian
Philippines|PH|sea|Filipino,Philippine
Poland|PL|eu|Polish
Portugal|PT|eu|Portuguese
Qatar|QA|mena|Qatari
Republic of Korea|KR|east_asia|South Korea,South Korean,Korean,Korea
Republic of Moldova|MD|europe_other|
Republic of North Macedonia|MK|europe_other|North Macedonia,Macedonian
Romania|RO|eu|Romanian
Russian Federation|RU|europe_other|Russia,Russian
Rwanda|RW|africa|Rwandan
Saint Lucia|LC|latam|Saint Lucian
San Marino|SM|europe_other|Sammarinese
Saudi Arabia|SA|mena|Saudi
Senegal|SN|africa|Senegalese
Serbia|RS|europe_other|Serbian
Sierra Leone|SL|africa|Sierra Leonean
Singapore|SG|sea|Singaporean
Slovakia|SK|eu|Slovak,Slovakian
Slovenia|SI|eu|Slovenian,Slovene
Somalia|SO|africa|Somali
South Africa|ZA|africa|South African
South Korea|KR|east_asia|
Spain|ES|eu|Spanish
Sri Lanka|LK|south_asia|Sri Lankan
Sudan|SD|africa|Sudanese
Suriname|SR|latam|Surinamese
Swaziland|SZ|africa|Eswatini,Swazi
Sweden|SE|eu|Swedish
Switzerland|CH|europe_other|Swiss
Syrian Arab Republic|SY|mena|Syria,Syrian
Taiwan|TW|east_asia|Taiwanese
Tajikistan|TJ|europe_other|Tajik
Thailand|TH|sea|Thai
Timor-Leste|TL|sea|East Timor,Timorese
Togo|TG|africa|Togolese
Trinidad and Tobago|TT|latam|Trinidadian
Tunisia|TN|mena|Tunisian
Turkey|TR|europe_other|Turkish,Türkiye
Turkmenistan|TM|europe_other|Turkmen
Uganda|UG|africa|Ugandan
Ukraine|UA|europe_other|Ukrainian
United Arab Emirates|AE|mena|UAE,Emirati
United Kingdom of Great Britain and Northern Ireland|GB|uk|United Kingdom,UK,U.K.,British,Britain,England,Scotland,Scottish,Wales,Welsh,Northern Ireland
United Republic of Tanzania|TZ|africa|Tanzania,Tanzanian
United States of America|US|north_america|United States,USA,U.S.,US,American
Uruguay|UY|latam|Uruguayan
Uzbekistan|UZ|europe_other|Uzbek
Venezuela, Bolivarian Republic of...|VE|latam|Venezuela,Venezuelan
Viet Nam|VN|sea|Vietnam,Vietnamese
Yemen|YE|mena|Yemeni
Zambia|ZM|africa|Zambian
Zimbabwe|ZW|africa|Zimbabwean
"""

COUNTRY_ISO2, ISO2_REGION, NAME_ISO2, ISO2_NAME = {}, {}, {}, {}
for _line in _TABLE.strip().splitlines():
    _survey, _iso, _region, _names = _line.split("|")
    assert _region in REGIONS, _line
    COUNTRY_ISO2[_survey] = _iso
    ISO2_REGION[_iso] = _region
    ISO2_NAME.setdefault(_iso, _survey)
    for _n in [_survey, *[x.strip() for x in _names.split(",") if x.strip()]]:
        if "," in _n or "..." in _n or "(" in _n:
            continue
        assert NAME_ISO2.get(_n, _iso) == _iso, _n
        NAME_ISO2[_n] = _iso
# Short display names for the survey's long official ones (country_name in the facets).
ISO2_NAME.update({"GB": "United Kingdom", "US": "United States", "KR": "South Korea", "KP": "North Korea", "IR": "Iran",
                  "RU": "Russia", "VE": "Venezuela", "VN": "Vietnam", "SY": "Syria", "LY": "Libya", "LA": "Laos",
                  "TZ": "Tanzania", "MD": "Moldova", "MK": "North Macedonia", "HK": "Hong Kong", "CG": "Republic of the Congo",
                  "FM": "Micronesia", "BN": "Brunei", "SZ": "Eswatini"})


_NAME_RE = re.compile(r"(?<![\w.])(" + "|".join(sorted((re.escape(n) for n in NAME_ISO2), key=len, reverse=True)) + r")(?![\w])")


def mentioned_countries(text, skip=()):
    """ISO2 codes of the countries a piece of prose names ("a Swedish university", "US-based"). `skip`: words that are
    not places here (the persona's own first name, e.g. Jordan or Georgia)."""
    out = set()
    for m in _NAME_RE.finditer(text or ""):
        if m.group(1) not in skip: out.add(NAME_ISO2[m.group(1)])
    return out


def ts_module():
    """The maps as a TypeScript module for the server (src/geo-data.ts); regenerate after editing the table."""
    names = {iso: sorted(n for n, i in NAME_ISO2.items() if i == iso) for iso in ISO2_REGION}
    return ("// Generated by vault/build/geo.py --ts; edit the table there, not here.\n"
            f"export const REGIONS = {json.dumps(REGIONS)} as const;\n"
            f"export const ISO2_REGION: Record<string, string> = {json.dumps(ISO2_REGION, ensure_ascii=False, sort_keys=True)};\n"
            f"export const ISO2_NAME: Record<string, string> = {json.dumps(ISO2_NAME, ensure_ascii=False, sort_keys=True)};\n"
            f"export const ISO2_NAMES: Record<string, string[]> = {json.dumps(names, ensure_ascii=False, sort_keys=True)};\n")


if __name__ == "__main__":
    if sys.argv[1:] == ["--ts"]: sys.stdout.write(ts_module())
    else: sys.exit(__doc__)
