// Measured against the FAA 2026-09-03 GeoTIFFs; see docs/chart-seams.md.
// Keep the printed map frame: clipping inside its thick stroke creates gaps
// between adjoining sheets. Coordinates retain the FAA georeferencing.
import type { LongitudeLatitude } from './chartmaker-cutlines.ts';

export const IFR_NEATLINE_PROVENANCE = 'local-printed-frame@faa-raster-2026-09-03' as const;

export type IfrNeatline = {
    sourceSha256: string;
    sourceSize: readonly [number, number];
    // Pixel/line edges, with the full printed frame and without scale rulers.
    pixelBounds: readonly [left: number, top: number, right: number, bottom: number];
    coordinates: readonly LongitudeLatitude[];
};

export const IFR_NEATLINES: Readonly<Record<string, IfrNeatline>> = {

    'ifr-enroute-high-h01.tif': {
        sourceSha256: '04284d394be73501e79337dcdb231376ba02de23a5984c8cfa962257003385f6',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 196, 23905, 7805],
        coordinates: [
            [-131.211083217, 48.141391274],
            [-104.024501904, 50.087060552],
            [-104.390194149, 43.784620719],
            [-129.036445194, 41.994816475],
        ],
    },
    'ifr-enroute-high-h02.tif': {
        sourceSha256: '1c7ab1c5a291c6c76630992dd1221a174cb3640060637fdd4ba179f7fab58f9d',
        sourceSize: [24000, 8000],
        pixelBounds: [2096, 196, 21905, 7805],
        coordinates: [
            [-108.312522448, 49.384345094],
            [-83.231735487, 49.524124517],
            [-84.356067509, 43.255929724],
            [-107.045515625, 43.127269757],
        ],
    },
    'ifr-enroute-high-h03.tif': {
        sourceSha256: 'c878126781c021e68cedcab26fdc75297cb8e5674b0c8a03427f4b01fd5ecfcf',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 96, 23905, 7805],
        coordinates: [
            [-129.043815973, 42.003904447],
            [-104.394707706, 43.795099291],
            [-104.698730592, 37.341048556],
            [-127.210253386, 35.701985971],
        ],
    },
    'ifr-enroute-high-h04.tif': {
        sourceSha256: '0f57a80de9f095a86fa24efaabc0ceae5934f1b7fb87405e7229da51ae32333c',
        sourceSize: [24000, 8000],
        pixelBounds: [196, 96, 21904, 7744],
        coordinates: [
            [-127.209419859, 35.708555418],
            [-104.696264351, 37.347080709],
            [-104.950176891, 30.957810059],
            [-125.676109610, 29.463946996],
        ],
    },
    'ifr-enroute-high-h05.tif': {
        sourceSha256: '4bb98d166aa3519a9c429c4d99839d938c7f1514aabb8b8e036aa22cdd08ed2c',
        sourceSize: [24000, 8000],
        pixelBounds: [2095, 96, 21904, 7805],
        coordinates: [
            [-107.047024668, 43.132882729],
            [-84.356649480, 43.261646360],
            [-85.296467974, 36.842413960],
            [-105.986111277, 36.724579236],
        ],
    },
    'ifr-enroute-high-h06.tif': {
        sourceSha256: '7b859a2ccba308baca492c9f40e16d3df872e5a1ce3915de4eaa18bb4877e909',
        sourceSize: [24000, 8000],
        pixelBounds: [2096, 96, 21905, 7805],
        coordinates: [
            [-106.418163602, 36.688703900],
            [-85.727769826, 36.885974949],
            [-86.481173447, 30.477026521],
            [-105.493930750, 30.297319676],
        ],
    },
    'ifr-enroute-high-h07.tif': {
        sourceSha256: 'b8dce358e30ea4b0434f8a49466fe866d293278a74f41298a333912c0fff299c',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 96, 21905, 7745],
        coordinates: [
            [-105.495895014, 30.307881236],
            [-86.575195530, 30.495075484],
            [-87.204715788, 24.223990953],
            [-104.715672503, 24.054043467],
        ],
    },
    'ifr-enroute-high-h08.tif': {
        sourceSha256: '2f1eb6d9a517d8aecca09801937deaeb0fcd5f8938f244e2567c93f7bcc96f8d',
        sourceSize: [24000, 8000],
        pixelBounds: [2096, 96, 21805, 7745],
        coordinates: [
            [-90.155633052, 30.921595447],
            [-71.399940572, 29.289532167],
            [-72.748652949, 23.135491030],
            [-90.129398356, 24.616554898],
        ],
    },
    'ifr-enroute-high-h09.tif': {
        sourceSha256: 'b9ed7f28e002cf25f96839d858ca27f94f4102ebe193dada372309a1ff613632',
        sourceSize: [24000, 8000],
        pixelBounds: [2096, 96, 21805, 7805],
        coordinates: [
            [-87.885696642, 37.341600113],
            [-67.632388347, 35.144064161],
            [-69.384001804, 28.896250539],
            [-88.042976437, 30.898408652],
        ],
    },
    'ifr-enroute-high-h10.tif': {
        sourceSha256: '3fb166962c0b6871931d07e08c6440911d5b436d5c5001317101fe0fc93147d5',
        sourceSize: [24000, 8000],
        pixelBounds: [2096, 96, 21805, 7805],
        coordinates: [
            [-86.903263774, 43.775298885],
            [-64.824138096, 41.236213214],
            [-66.953497051, 34.996573595],
            [-87.162149644, 37.320736756],
        ],
    },
    'ifr-enroute-high-h11.tif': {
        sourceSha256: 'b2c1a87c0a275741f187e735c78c7f38c5b1ee37ecfd3c87be292933283eb147',
        sourceSize: [24000, 8000],
        pixelBounds: [4096, 196, 21805, 7805],
        coordinates: [
            [-84.122927059, 49.190296203],
            [-62.658182834, 46.539633547],
            [-65.115571242, 40.441431996],
            [-84.663740329, 42.879526166],
        ],
    },
    'ifr-enroute-high-h12.tif': {
        sourceSha256: 'bc5f9061ac0e6de3ea747e2c0fd380072e814bb93452f4cdb4019ffdbef221e6',
        sourceSize: [24000, 8000],
        pixelBounds: [96, 96, 23905, 7805],
        coordinates: [
            [-87.602049661, 32.477996933],
            [-74.317390651, 45.953830372],
            [-68.803138539, 42.194907364],
            [-82.418285924, 29.357928691],
        ],
    },
    'ifr-enroute-low-l01.tif': {
        sourceSha256: '05b6606761c5b9f1b62d6ad5fe6b2cfacf054ce114469f8689ddec35359e146a',
        sourceSize: [22000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-124.759284384, 42.795993627],
            [-124.987163475, 49.310355701],
            [-121.216022606, 49.322378473],
            [-121.357803475, 42.807021404],
        ],
    },
    'ifr-enroute-low-l02.tif': {
        sourceSha256: 'edd4332b3f907487e27751fca25671b149b1db55cdeaed771721cf0d5daf3d13',
        sourceSize: [22000, 8000],
        pixelBounds: [2196, 256, 19805, 7745],
        coordinates: [
            [-123.776782965, 36.954507495],
            [-124.909669742, 42.792923223],
            [-121.529969398, 43.132258633],
            [-120.664496769, 37.267378586],
        ],
    },
    'ifr-enroute-low-l03.tif': {
        sourceSha256: '90a951950fc01b3fb41ba244ec25bc55eb3f09d4ac6f92d524eb389a24f8995c',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-120.682465862, 39.744933198],
            [-117.357798770, 33.739805039],
            [-120.082366690, 32.729754115],
            [-123.585938188, 38.645109982],
        ],
    },
    'ifr-enroute-low-l04.tif': {
        sourceSha256: '750f85d432ae1b54dd75e61b48988e9e3fe500fd6d75e98d25c20c4c93f89736',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-120.697177966, 34.981340961],
            [-114.489188337, 34.408479077],
            [-114.861248343, 32.240867934],
            [-120.896059537, 32.795848985],
        ],
    },
    'ifr-enroute-low-l05.tif': {
        sourceSha256: '199de4402683dc964f0ba4b0558586570359a4a56a8f3ee1fd457479b0ce7e1b',
        sourceSize: [24000, 8000],
        pixelBounds: [6196, 256, 21805, 7745],
        coordinates: [
            [-115.406963633, 34.576784457],
            [-107.536952480, 34.236072667],
            [-107.881235442, 31.124774442],
            [-115.438220641, 31.450284805],
        ],
    },
    'ifr-enroute-low-l06n.tif': {
        sourceSha256: 'e58711af6fb7fe1e41537356fdc9a3e4e30526997bc566e2c6626fd2a43b1c39',
        sourceSize: [14000, 8000],
        pixelBounds: [196, 256, 13805, 7745],
        coordinates: [
            [-108.260806328, 34.379557111],
            [-101.405477795, 34.995048629],
            [-101.148147506, 31.874573559],
            [-107.733340730, 31.286474393],
        ],
    },
    'ifr-enroute-low-l06s.tif': {
        sourceSha256: 'fa438540e8fa52a7a47b8ad9f22c2acb05d737b476091e864c20d496efe6fe65',
        sourceSize: [8000, 8000],
        pixelBounds: [196, 256, 7805, 7745],
        coordinates: [
            [-106.772860577, 31.401974712],
            [-103.094082483, 31.747625037],
            [-102.781732792, 28.650856652],
            [-106.321128392, 28.320968532],
        ],
    },
    'ifr-enroute-low-l07.tif': {
        sourceSha256: '439b9f8cdd6a6899d88d4a5f35b9a33f4fef500a2e2c7b5f1e1e629130c9b9e2',
        sourceSize: [22000, 8000],
        pixelBounds: [2195, 256, 21804, 7745],
        coordinates: [
            [-121.180302314, 35.667256161],
            [-114.183581297, 36.605415265],
            [-113.853710864, 34.427600347],
            [-120.655852710, 33.518199329],
        ],
    },
    'ifr-enroute-low-l08.tif': {
        sourceSha256: 'c54b9b32f490fca883d95437a81860001626a7dbb951cba51e17128e101d0383',
        sourceSize: [22000, 8000],
        pixelBounds: [2196, 256, 19805, 7745],
        coordinates: [
            [-114.398610110, 36.560966297],
            [-105.293543618, 37.762944370],
            [-104.865418388, 34.644679292],
            [-113.607922974, 33.494814515],
        ],
    },
    'ifr-enroute-low-l09.tif': {
        sourceSha256: '0f0b0a9468f5fa188087c43a83b1bd780514ce25b328f16f7d6336206f066058',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-120.760413143, 40.214807736],
            [-105.688678020, 41.536547154],
            [-105.513776278, 37.143498149],
            [-119.700020948, 35.899894932],
        ],
    },
    'ifr-enroute-low-l10.tif': {
        sourceSha256: '8bbebdba9f9bc590b7b20744b875a18b76f9de26aa081e836d90e0c370077c0e',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-106.017230974, 40.869589360],
            [-94.321786280, 41.373623873],
            [-94.356444738, 37.605990620],
            [-105.447444887, 37.127734150],
        ],
    },
    'ifr-enroute-low-l11.tif': {
        sourceSha256: '0d3ab0f8ba79aef6e3f68e5fa6b6f6eadef2a10bbbcd7d83576dbea14e278c0a',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-121.880137865, 43.918307144],
            [-105.974769960, 44.216968128],
            [-106.325367121, 39.837185993],
            [-121.236910028, 39.555884710],
        ],
    },
    'ifr-enroute-low-l12.tif': {
        sourceSha256: '51f3a4be356eedff148c2dc2fa1d842deec402194aac5eb18b9bbdaa6e4f9a17',
        sourceSize: [24000, 8000],
        pixelBounds: [4197, 257, 21803, 7743],
        coordinates: [
            [-106.751632341, 45.191410642],
            [-92.228027541, 45.119739915],
            [-92.729352836, 40.754633492],
            [-106.330570028, 40.822140197],
        ],
    },
    'ifr-enroute-low-l13.tif': {
        sourceSha256: 'c64ce1b860aea3bee8c191b4d55666ad56992d840b132208ce295dc112c42eac',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-122.166762206, 48.896593018],
            [-102.496436520, 49.006859660],
            [-103.187092178, 44.056441600],
            [-121.360367012, 43.953239150],
        ],
    },
    'ifr-enroute-low-l14.tif': {
        sourceSha256: '049bafc589b764b4a54cd23403e9c263dba32932fd6981c87157995a72331eab',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-103.338046273, 49.072523052],
            [-87.940023541, 48.596766697],
            [-88.737360906, 44.279457943],
            [-103.104468547, 44.728501704],
        ],
    },
    'ifr-enroute-low-l15.tif': {
        sourceSha256: 'ee3444baf8eaf0986e3e95fe397f2be23bda6cffeae2c73e3c1957386283b4f1',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-105.310341631, 37.851618468],
            [-94.918203589, 38.314930603],
            [-94.922244493, 35.176438760],
            [-104.881195186, 34.733247692],
        ],
    },
    'ifr-enroute-low-l16.tif': {
        sourceSha256: '76f2fcd9778c2163585f42568d4925b0ad885732757e918244694173ff5c2566',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-94.922804462, 38.315015211],
            [-85.584032958, 37.929166427],
            [-85.977149943, 34.807355218],
            [-94.926155778, 35.176379481],
        ],
    },
    'ifr-enroute-low-l17.tif': {
        sourceSha256: 'de115cfc7ae083e7de0f356326bc9371f07b9f6744f1ced631907846282fcd7f',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-101.410358096, 34.994564935],
            [-92.442639398, 35.151252188],
            [-92.546107166, 32.023522414],
            [-101.153020412, 31.873786036],
        ],
    },
    'ifr-enroute-low-l18.tif': {
        sourceSha256: 'd3f29110ce8623651603a33fa371791b3fd7f88f4db08d83b857dbdfa40e6d3a',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 23805, 7745],
        coordinates: [
            [-92.446961589, 35.151264334],
            [-82.526612251, 34.472734828],
            [-83.024235203, 31.375416689],
            [-92.550400619, 32.023659518],
        ],
    },
    'ifr-enroute-low-l19.tif': {
        sourceSha256: 'eaf4bae5696c07fe7582a67ce4f5e3a351d03aa9bb1dc7dd22dd18e79fe6fe0a',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-103.098691319, 31.746795441],
            [-93.523859681, 32.044741252],
            [-93.581017290, 28.934605283],
            [-102.786247380, 28.650271182],
        ],
    },
    'ifr-enroute-low-l20.tif': {
        sourceSha256: '2af6e9e0a5a3d85268c69840d99a270504b068ba51d93a97c437c89a1d03dd07',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 255, 19805, 7744],
        coordinates: [
            [-101.851274778, 28.721091746],
            [-93.580514263, 28.938771466],
            [-93.633693534, 25.855047356],
            [-101.596704163, 25.647524649],
        ],
    },
    'ifr-enroute-low-l21.tif': {
        sourceSha256: '893504f48c67fe46594c39d165dbbd93712aa1f35b624d7ad4b9d3b8f148add6',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 17805, 7745],
        coordinates: [
            [-98.053248739, 31.508751863],
            [-80.717782572, 30.582788139],
            [-81.905076977, 23.579744952],
            [-97.795227073, 24.409881595],
        ],
    },
    'ifr-enroute-low-l22.tif': {
        sourceSha256: 'ea0d028263239d91233cf8cea527634f0de7154e6c16dba7e69ab824c6ae97af',
        sourceSize: [24000, 8000],
        pixelBounds: [196, 256, 21805, 7745],
        coordinates: [
            [-93.528474423, 32.045416008],
            [-83.022617643, 31.378791744],
            [-83.482210309, 28.299153321],
            [-93.585855717, 28.935341898],
        ],
    },
    'ifr-enroute-low-l23.tif': {
        sourceSha256: '5a64200c14712accc217483c2b3fa55c9b05c76fb672d9bffcc7051e2fa52a87',
        sourceSize: [24000, 8000],
        pixelBounds: [5176, 256, 21805, 7745],
        coordinates: [
            [-83.515549413, 27.834558904],
            [-75.960236491, 26.689021275],
            [-76.647339719, 23.692798576],
            [-83.937371718, 24.784945452],
        ],
    },
    'ifr-enroute-low-l24.tif': {
        sourceSha256: '780617961e2bf2a3687a2cb00584ee1855318afc1866edaefd148858ec63a4b7',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-83.552402076, 27.835585580],
            [-82.425361518, 35.098040194],
            [-78.671179327, 34.601553287],
            [-80.123482425, 27.389964570],
        ],
    },
    'ifr-enroute-low-l25.tif': {
        sourceSha256: '573e8064f9adb92f6d281a95d88d91a11baafb3820214ad6e948e0f69f44ccb5',
        sourceSize: [22000, 8000],
        pixelBounds: [2195, 256, 19804, 7745],
        coordinates: [
            [-85.710593326, 36.993783827],
            [-79.357995491, 36.286688813],
            [-79.809675244, 34.123357015],
            [-85.982230030, 34.808727613],
        ],
    },
    'ifr-enroute-low-l26.tif': {
        sourceSha256: '68098caed79e70674c9f9befaf2ff9b4f2fa98c1f56df889a49ff368c7e0d121',
        sourceSize: [22000, 8000],
        pixelBounds: [196, 253, 19805, 7745],
        coordinates: [
            [-85.521871725, 39.185990574],
            [-78.243826635, 38.357515917],
            [-78.741369687, 36.195045222],
            [-85.807713139, 36.998466855],
        ],
    },
    'ifr-enroute-low-l27.tif': {
        sourceSha256: '889ada46f08efdbbb38e7f49505346fc17eec40b7c09d99954bf8b5f3b629bf8',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-94.326679305, 41.449064633],
            [-83.474173288, 40.897144946],
            [-83.973742458, 37.781437765],
            [-94.355293503, 38.309967611],
        ],
    },
    'ifr-enroute-low-l28.tif': {
        sourceSha256: 'da93f9dea51f3fc18df75f5de6161dd6297592efc268a235055852c5a552a9e7',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 19805, 7745],
        coordinates: [
            [-92.717538885, 44.557013547],
            [-82.523142102, 43.959917830],
            [-83.088742349, 40.855704981],
            [-92.822222061, 41.427993379],
        ],
    },
    'ifr-enroute-low-l29.tif': {
        sourceSha256: '948babfd39fc172b52bf76ca784944f7a49ec480ab227236453c3a79cc0f7ab9',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-83.425196544, 41.208103915],
            [-75.969844792, 40.243262760],
            [-76.548063437, 38.091717699],
            [-83.783166461, 39.027964598],
        ],
    },
    'ifr-enroute-low-l30.tif': {
        sourceSha256: 'd00e6ab850aa8dc7e4d97070aa9d7d5ebff197684284ccc93207e3fddf4e390a',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 21805, 7745],
        coordinates: [
            [-82.644459553, 43.347041241],
            [-74.967009838, 42.328916819],
            [-75.593463657, 40.184641385],
            [-83.038342542, 41.173098908],
        ],
    },
    'ifr-enroute-low-l31.tif': {
        sourceSha256: 'f28aab62e87b320e346d41d9f69ee8f24144eebe0a5c7923cffe34326ada10dc',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 21805, 7745],
        coordinates: [
            [-88.061307780, 48.059250360],
            [-75.757671675, 45.664562298],
            [-77.460521402, 42.121076510],
            [-89.143021444, 44.402591190],
        ],
    },
    'ifr-enroute-low-l32.tif': {
        sourceSha256: 'bd71a5e356775dd98fa611de8ef5c6ce279609bd2e27615e094bc43e2a2b7a5a',
        sourceSize: [24000, 8000],
        pixelBounds: [4196, 256, 23805, 7745],
        coordinates: [
            [-79.499330547, 46.047862720],
            [-63.070251770, 47.938331556],
            [-62.614650859, 43.590371721],
            [-78.010987174, 41.806060043],
        ],
    },
    'ifr-enroute-low-l33.tif': {
        sourceSha256: 'a85893e147f2ad7ffa605ef13a3ab6e7056d4b31d122b3b2afcc06a9c650f326',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 17805, 7745],
        coordinates: [
            [-76.187483953, 42.439217488],
            [-70.099480428, 43.360024597],
            [-69.609749841, 41.196969921],
            [-75.515754674, 40.302857069],
        ],
    },
    'ifr-enroute-low-l34.tif': {
        sourceSha256: 'b077a9f3c6b490f6cb1d618cded3437b05957f606114ecd755d2373472c511a1',
        sourceSize: [24000, 8000],
        pixelBounds: [196, 251, 23805, 7740],
        coordinates: [
            [-78.771558034, 38.383201904],
            [-72.895632446, 43.690208988],
            [-70.696131025, 42.209220282],
            [-76.615330228, 37.006087726],
        ],
    },
    'ifr-enroute-low-l35.tif': {
        sourceSha256: '238ecb3180b10fbebe945437f779e9d7b87dbdfc00984f2d6d39e2b9da5822a6',
        sourceSize: [24000, 8000],
        pixelBounds: [2196, 256, 17805, 7745],
        coordinates: [
            [-80.228207268, 34.790365742],
            [-75.815612168, 37.651810904],
            [-74.180118463, 35.891821218],
            [-78.553720252, 33.100484381],
        ],
    },
    'ifr-enroute-low-l36.tif': {
        sourceSha256: 'd23501c70442204b8512a7af7efdf19e026a6cf997c51273aac1a19daa03006a',
        sourceSize: [24000, 8000],
        pixelBounds: [196, 256, 21805, 7745],
        coordinates: [
            [-81.553700231, 34.905037577],
            [-76.638215912, 39.889655267],
            [-74.488653118, 38.464046422],
            [-79.454413472, 33.575987801],
        ],
    },
};
