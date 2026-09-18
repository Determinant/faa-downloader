# Third-party notices

## NOAA / BGS World Magnetic Model 2025

`data/WMM2025.COF` is an unmodified copy of `WMM2025COF/WMM2025.COF` from
[NOAA's WMM2025 coefficient archive](https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip),
released December 17, 2024 and retrieved September 18, 2026. Its SHA-256 is
`dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f`.

Model citation: NOAA NCEI Geomagnetic Modeling Team; British Geological Survey.
2024: World Magnetic Model 2025. NOAA National Centers for Environmental
Information. <https://doi.org/10.25921/aqfd-sd83>.

The generated `nav/magnetic-model.json` reproduces these coefficients and annual
changes with source attribution and an explicit model validity interval. This
incorporated U.S. Government material is in the public domain and is not subject
to copyright protection. See [NOAA's WMM notice](https://www.ncei.noaa.gov/products/world-magnetic-model).

## N129BZ/chartmaker chart cutlines

The generated sectional, terminal-area, and IFR enroute cutline coordinates in
`lib/chartmaker-cutlines.ts` are adapted from the `clipshapes` data in
[N129BZ/chartmaker](https://github.com/N129BZ/chartmaker), commit
`1d71db443916b8052dde41d612c3311bac25a5ae`.

MIT License

Copyright (c) 2022 Brian A. Manlove

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
