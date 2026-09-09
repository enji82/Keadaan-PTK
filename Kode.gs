/**
 * DASHBOARD KEADAAN & ANALISIS KEBUTUHAN PTK
 * Server-side Google Apps Script
 */

const SPREADSHEET_ID = '1vOGuQ0McBu1ZbGC5XfITaIa5Rdk5o22KG_3MvvVLnVA';

/**
 * Endpoint Web App (HTML Service)
 */
function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('Dashboard Keadaan & Kebutuhan PTK')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Helper include file HTML modular
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Normalisasi Status Kepegawaian (Kolom K)
 * Kategori: PNS, PPPK, PW (PPPK Paruh Waktu), Non-ASN
 */
function normalizeStatusKepegawaian(rawStatus) {
  if (!rawStatus) return 'Non-ASN';
  const val = String(rawStatus).trim().toUpperCase();
  
  if (val.includes('PARUH WAKTU') || val.includes(' PW') || val === 'PW') {
    return 'PW';
  } else if (val.includes('PNS') && !val.includes('PPPK') && !val.includes('NON')) {
    return 'PNS';
  } else if (val.includes('PPPK') || val.includes('P3K')) {
    return 'PPPK';
  } else {
    return 'Non-ASN';
  }
}

/**
 * Normalisasi Peran Umum PTK (Guru, Tendik, KS)
 */
function normalizeJenisPTK(rawTugas) {
  if (!rawTugas) return 'Tendik';
  const val = String(rawTugas).trim().toLowerCase();
  
  if (val.includes('kepala sekolah') || val.includes('ks') || val === 'kasek') {
    return 'Kepala Sekolah';
  }
  
  if (
    val.includes('guru') || 
    val.includes('pendidik') || 
    val.includes('pengajar') ||
    val.includes('wali kelas') ||
    val.includes('bk') ||
    val.includes('bimbingan') ||
    val.includes('penjas') ||
    val.includes('pai') ||
    val.includes('mapel')
  ) {
    return 'Guru';
  }
  
  return 'Tendik';
}

/**
 * Normalisasi Jenis Formasi Guru SD
 * Kategori: 'KS', 'GURU_KELAS', 'GURU_PAI', 'GURU_PJOK', 'GURU_KRISTEN', 'GURU_KATOLIK', 'GURU_LAIN'
 */
function mapFormasiGuruSD(rawTugas) {
  if (!rawTugas) return null;
  const val = String(rawTugas).trim().toLowerCase();
  
  if (val.includes('kepala sekolah') || val.includes('ks') || val === 'kasek') {
    return 'KS';
  }
  if (val.includes('guru kelas') || val === 'guru kelas' || val.includes('wali kelas')) {
    return 'GURU_KELAS';
  }
  if (val.includes('pai') || val.includes('agama islam')) {
    return 'GURU_PAI';
  }
  if (val.includes('pjok') || val.includes('penjas') || val.includes('olahraga')) {
    return 'GURU_PJOK';
  }
  if (val.includes('kristen') || val.includes('protestan')) {
    return 'GURU_KRISTEN';
  }
  if (val.includes('katolik')) {
    return 'GURU_KATOLIK';
  }
  if (val.includes('guru')) {
    return 'GURU_LAIN';
  }
  return null;
}

/**
 * Rumus Kebutuhan Guru PAI & PJOK SD Berdasarkan Rombel
 * 1-10 rombel: 1
 * 11-16 rombel: 2
 * 17-22 rombel: 3
 * 23-24 rombel: 4
 * >24 rombel: Math.ceil(rombel / 6)
 */
function hitungKebutuhanMapelSD(rombel) {
  const r = parseInt(rombel) || 0;
  if (r <= 0) return 0;
  if (r <= 10) return 1;
  if (r <= 16) return 2;
  if (r <= 22) return 3;
  if (r <= 24) return 4;
  return Math.ceil(r / 6);
}

/**
 * Mengambil seluruh data dashboard (Rekap Umum + Analisis Kebutuhan Guru SD)
 */
function getDashboardData(forceRefresh) {
  const cache = CacheService.getScriptCache();
  const CACHE_KEY = 'REKAP_PTK_WITH_KEBUTUHAN_V3';
  
  if (!forceRefresh) {
    const cached = cache.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // 1. Ambil Master DataUnit
  const sheetUnit = ss.getSheetByName('DataUnit');
  if (!sheetUnit) throw new Error("Sheet 'DataUnit' tidak ditemukan!");
  
  const unitValues = sheetUnit.getDataRange().getValues();
  if (unitValues.length < 2) throw new Error("Sheet 'DataUnit' kosong!");
  
  const unitHeader = unitValues[0].map(h => String(h).trim().toLowerCase());
  
  let npsnColIdx = unitHeader.indexOf('npsn');
  if (npsnColIdx === -1) npsnColIdx = 39; // Kolom AN
  
  let unitKerjaColIdx = unitHeader.indexOf('unit kerja');
  if (unitKerjaColIdx === -1) unitKerjaColIdx = 0; // Kolom A
  
  let kecColIdx = unitHeader.indexOf('kecamatan');
  if (kecColIdx === -1) kecColIdx = 1; // Kolom B

  let rombelColIdx = unitHeader.indexOf('jml rombel');
  if (rombelColIdx === -1) rombelColIdx = 2; // Kolom C

  let muridColIdx = unitHeader.findIndex(h => h.includes('murid') || h.includes('siswa') || h.includes('peserta didik'));
  if (muridColIdx === -1) {
    // Coba cari nama kolom umum murid
    muridColIdx = unitHeader.indexOf('jml murid');
    if (muridColIdx === -1) muridColIdx = unitHeader.indexOf('jml siswa');
  }

  let butuhKristenColIdx = unitHeader.indexOf('kebutuhan guru pa kristen');
  if (butuhKristenColIdx === -1) butuhKristenColIdx = 11; // Kolom L

  let butuhKatolikColIdx = unitHeader.indexOf('kebutuhan guru pa katolik');
  if (butuhKatolikColIdx === -1) butuhKatolikColIdx = 22; // Kolom W
  
  const schoolMaster = {}; 
  const kecamatanSet = new Set();
  
  for (let i = 1; i < unitValues.length; i++) {
    const row = unitValues[i];
    const npsn = String(row[npsnColIdx] || '').trim();
    const namaSekolah = String(row[unitKerjaColIdx] || '').trim();
    let kecamatan = String(row[kecColIdx] || '').trim();
    
    if (!npsn && !namaSekolah) continue;
    
    if (kecamatan) {
      kecamatan = kecamatan.toUpperCase();
      kecamatanSet.add(kecamatan);
    } else {
      kecamatan = 'LAINNYA';
    }
    
    let jenjang = 'SD';
    const upperName = namaSekolah.toUpperCase();
    if (upperName.includes('SMP')) {
      jenjang = 'SMP';
    } else if (upperName.includes('TK') || upperName.includes('PAUD')) {
      jenjang = 'PAUD/TK';
    }

    const rombel = parseInt(row[rombelColIdx]) || 0;
    const murid = muridColIdx !== -1 ? (parseInt(row[muridColIdx]) || 0) : 0;
    const butuhKristen = parseInt(row[butuhKristenColIdx]) || 0;
    const butuhKatolik = parseInt(row[butuhKatolikColIdx]) || 0;
    
    const key = npsn || ('NAME_' + namaSekolah.toUpperCase());
    schoolMaster[key] = {
      npsn: npsn || '-',
      namaSekolah: namaSekolah,
      kecamatan: kecamatan,
      jenjang: jenjang,
      rombel: rombel,
      murid: murid,
      butuhKristen: butuhKristen,
      butuhKatolik: butuhKatolik,
      
      // Counter Umum
      ptkCount: 0,
      guruCount: 0,
      ksCount: 0,
      tendikCount: 0,
      pnsCount: 0,
      pppkCount: 0,
      pwCount: 0,
      nonAsnCount: 0,

      // Komposisi Khusus Guru SD (Kebutuhan & Ketersediaan)
      formasiSD: {
        KS: { butuh: (jenjang === 'SD' ? 1 : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
        GURU_KELAS: { butuh: (jenjang === 'SD' ? rombel : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
        GURU_PAI: { butuh: (jenjang === 'SD' ? hitungKebutuhanMapelSD(rombel) : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
        GURU_PJOK: { butuh: (jenjang === 'SD' ? hitungKebutuhanMapelSD(rombel) : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
        GURU_KRISTEN: { butuh: (jenjang === 'SD' ? butuhKristen : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
        GURU_KATOLIK: { butuh: (jenjang === 'SD' ? butuhKatolik : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 }
      }
    };
  }

  // 2. Baca Data PTK SD ('Data') & SMP ('Data2')
  const ptkSDList = readPTKSheet(ss, 'Data', 'SD');
  const ptkSMPList = readPTKSheet(ss, 'Data2', 'SMP');
  const allPTK = ptkSDList.concat(ptkSMPList);

  // 3. Agregasi ke School Master
  allPTK.forEach(ptk => {
    let schKey = ptk.npsn;
    if (!schKey || !schoolMaster[schKey]) {
      const altKey = 'NAME_' + (ptk.unitKerja || '').toUpperCase();
      if (schoolMaster[altKey]) schKey = altKey;
    }
    
    if (!schoolMaster[schKey]) {
      const fallbackKec = (ptk.kecamatan || 'LAINNYA').toUpperCase();
      kecamatanSet.add(fallbackKec);
      schoolMaster[schKey] = {
        npsn: ptk.npsn || '-',
        namaSekolah: ptk.unitKerja || ('Sekolah ' + ptk.npsn),
        kecamatan: fallbackKec,
        jenjang: ptk.jenjang,
        rombel: 0,
        butuhKristen: 0,
        butuhKatolik: 0,
        ptkCount: 0,
        guruCount: 0,
        ksCount: 0,
        tendikCount: 0,
        pnsCount: 0,
        pppkCount: 0,
        pwCount: 0,
        nonAsnCount: 0,
        formasiSD: {
          KS: { butuh: (ptk.jenjang === 'SD' ? 1 : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
          GURU_KELAS: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
          GURU_PAI: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
          GURU_PJOK: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
          GURU_KRISTEN: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
          GURU_KATOLIK: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 }
        }
      };
    }
    
    const sch = schoolMaster[schKey];
    sch.ptkCount++;
    
    // Status kepegawaian
    if (ptk.statusNorm === 'PNS') sch.pnsCount++;
    else if (ptk.statusNorm === 'PPPK') sch.pppkCount++;
    else if (ptk.statusNorm === 'PW') sch.pwCount++;
    else sch.nonAsnCount++;
    
    // Peran umum
    if (ptk.jenisNorm === 'Kepala Sekolah') {
      sch.ksCount++;
    } else if (ptk.jenisNorm === 'Guru') {
      sch.guruCount++;
    } else {
      sch.tendikCount++;
    }

    // Pemetaan khusus Formasi SD
    if (ptk.jenjang === 'SD') {
      const formasi = mapFormasiGuruSD(ptk.tugasRaw);
      if (formasi && sch.formasiSD[formasi]) {
        const targetFormasi = sch.formasiSD[formasi];
        if (ptk.statusNorm === 'PNS') targetFormasi.pns++;
        else if (ptk.statusNorm === 'PPPK') targetFormasi.pppk++;
        else if (ptk.statusNorm === 'PW') targetFormasi.pw++;
        else targetFormasi.nonAsn++;
      }
    }
  });

  // 4. Hitung Analisis Kebutuhan Guru SD (Per Sekolah & Per Kecamatan)
  const listSekolah = Object.values(schoolMaster);
  const listSD = listSekolah.filter(s => s.jenjang === 'SD');

  const rekapKebutuhanSD_Sekolah = [];
  const rekapKebutuhanSD_Kecamatan = {};

  listSD.forEach(sd => {
    const f = sd.formasiSD;
    
    // Hitung total untuk sekolah ini
    const totalButuh = f.KS.butuh + f.GURU_KELAS.butuh + f.GURU_PAI.butuh + f.GURU_PJOK.butuh + f.GURU_KRISTEN.butuh + f.GURU_KATOLIK.butuh;
    const totalPNS = f.KS.pns + f.GURU_KELAS.pns + f.GURU_PAI.pns + f.GURU_PJOK.pns + f.GURU_KRISTEN.pns + f.GURU_KATOLIK.pns;
    const totalPPPK = f.KS.pppk + f.GURU_KELAS.pppk + f.GURU_PAI.pppk + f.GURU_PJOK.pppk + f.GURU_KRISTEN.pppk + f.GURU_KATOLIK.pppk;
    const totalPW = f.KS.pw + f.GURU_KELAS.pw + f.GURU_PAI.pw + f.GURU_PJOK.pw + f.GURU_KRISTEN.pw + f.GURU_KATOLIK.pw;
    const totalPengurang = totalPNS + totalPPPK + totalPW;
    const totalSelisih = totalPengurang - totalButuh;
    const totalNonASN = f.KS.nonAsn + f.GURU_KELAS.nonAsn + f.GURU_PAI.nonAsn + f.GURU_PJOK.nonAsn + f.GURU_KRISTEN.nonAsn + f.GURU_KATOLIK.nonAsn;

    // Hitung selisih per formasi
    const calcSelisih = (item) => (item.pns + item.pppk + item.pw) - item.butuh;

    const rowSekolah = {
      npsn: sd.npsn,
      namaSekolah: sd.namaSekolah,
      kecamatan: sd.kecamatan,
      rombel: sd.rombel,
      murid: sd.murid || 0,
      
      // Rincian per formasi
      ks: { butuh: f.KS.butuh, pns: f.KS.pns, pppk: f.KS.pppk, pw: f.KS.pw, selisih: calcSelisih(f.KS), nonAsn: f.KS.nonAsn },
      guruKelas: { butuh: f.GURU_KELAS.butuh, pns: f.GURU_KELAS.pns, pppk: f.GURU_KELAS.pppk, pw: f.GURU_KELAS.pw, selisih: calcSelisih(f.GURU_KELAS), nonAsn: f.GURU_KELAS.nonAsn },
      guruPai: { butuh: f.GURU_PAI.butuh, pns: f.GURU_PAI.pns, pppk: f.GURU_PAI.pppk, pw: f.GURU_PAI.pw, selisih: calcSelisih(f.GURU_PAI), nonAsn: f.GURU_PAI.nonAsn },
      guruPjok: { butuh: f.GURU_PJOK.butuh, pns: f.GURU_PJOK.pns, pppk: f.GURU_PJOK.pppk, pw: f.GURU_PJOK.pw, selisih: calcSelisih(f.GURU_PJOK), nonAsn: f.GURU_PJOK.nonAsn },
      guruKristen: { butuh: f.GURU_KRISTEN.butuh, pns: f.GURU_KRISTEN.pns, pppk: f.GURU_KRISTEN.pppk, pw: f.GURU_KRISTEN.pw, selisih: calcSelisih(f.GURU_KRISTEN), nonAsn: f.GURU_KRISTEN.nonAsn },
      guruKatolik: { butuh: f.GURU_KATOLIK.butuh, pns: f.GURU_KATOLIK.pns, pppk: f.GURU_KATOLIK.pppk, pw: f.GURU_KATOLIK.pw, selisih: calcSelisih(f.GURU_KATOLIK), nonAsn: f.GURU_KATOLIK.nonAsn },
      
      // Total Sekolah
      total: {
        butuh: totalButuh,
        pns: totalPNS,
        pppk: totalPPPK,
        pw: totalPW,
        pengurang: totalPengurang,
        selisih: totalSelisih,
        nonAsn: totalNonASN
      }
    };
    rekapKebutuhanSD_Sekolah.push(rowSekolah);

    // Agregasi ke Kecamatan
    const kec = sd.kecamatan || 'LAINNYA';
    if (!rekapKebutuhanSD_Kecamatan[kec]) {
      rekapKebutuhanSD_Kecamatan[kec] = {
        kecamatan: kec,
        jmlSekolah: 0,
        totalMurid: 0,
        totalRombel: 0,
        ks: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        guruKelas: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        guruPai: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        guruPjok: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        guruKristen: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        guruKatolik: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 },
        total: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0 }
      };
    }
    
    const rk = rekapKebutuhanSD_Kecamatan[kec];
    rk.jmlSekolah++;
    rk.totalMurid += (sd.murid || 0);
    rk.totalRombel += sd.rombel;
    
    const akumulasi = (target, src) => {
      target.butuh += src.butuh;
      target.pns += src.pns;
      target.pppk += src.pppk;
      target.pw += src.pw;
      target.selisih += src.selisih;
      target.nonAsn += src.nonAsn;
    };

    akumulasi(rk.ks, rowSekolah.ks);
    akumulasi(rk.guruKelas, rowSekolah.guruKelas);
    akumulasi(rk.guruPai, rowSekolah.guruPai);
    akumulasi(rk.guruPjok, rowSekolah.guruPjok);
    akumulasi(rk.guruKristen, rowSekolah.guruKristen);
    akumulasi(rk.guruKatolik, rowSekolah.guruKatolik);
    akumulasi(rk.total, rowSekolah.total);
  });

  // 5. Rekap Wilayah Kecamatan & Jenjang Umum
  const rekapKecamatan = {};
  listSekolah.forEach(sch => {
    const kec = sch.kecamatan || 'LAINNYA';
    if (!rekapKecamatan[kec]) {
      rekapKecamatan[kec] = {
        kecamatan: kec,
        jmlSekolahSD: 0,
        jmlSekolahSMP: 0,
        totalSekolah: 0,
        totalPTK: 0,
        guru: 0,
        ks: 0,
        tendik: 0,
        pns: 0,
        pppk: 0,
        pw: 0,
        nonAsn: 0
      };
    }
    const rk = rekapKecamatan[kec];
    rk.totalSekolah++;
    if (sch.jenjang === 'SD') rk.jmlSekolahSD++;
    else if (sch.jenjang === 'SMP') rk.jmlSekolahSMP++;
    
    rk.totalPTK += sch.ptkCount;
    rk.guru += sch.guruCount;
    rk.ks += sch.ksCount;
    rk.tendik += sch.tendikCount;
    rk.pns += sch.pnsCount;
    rk.pppk += sch.pppkCount;
    rk.pw += sch.pwCount;
    rk.nonAsn += sch.nonAsnCount;
  });

  const rekapJenjang = {
    SD: { jenjang: 'SD', jmlSekolah: listSD.length, totalPTK: ptkSDList.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
    SMP: { jenjang: 'SMP', jmlSekolah: listSekolah.filter(s => s.jenjang === 'SMP').length, totalPTK: ptkSMPList.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 },
    TOTAL: { jenjang: 'TOTAL (SD & SMP)', jmlSekolah: listSekolah.length, totalPTK: allPTK.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0 }
  };

  allPTK.forEach(ptk => {
    const target = rekapJenjang[ptk.jenjang] || rekapJenjang.SD;
    const tot = rekapJenjang.TOTAL;
    
    if (ptk.statusNorm === 'PNS') { target.pns++; tot.pns++; }
    else if (ptk.statusNorm === 'PPPK') { target.pppk++; tot.pppk++; }
    else if (ptk.statusNorm === 'PW') { target.pw++; tot.pw++; }
    else { target.nonAsn++; tot.nonAsn++; }
    
    if (ptk.jenisNorm === 'Kepala Sekolah') { target.ks++; tot.ks++; }
    else if (ptk.jenisNorm === 'Guru') { target.guru++; tot.guru++; }
    else { target.tendik++; tot.tendik++; }
  });

  const finalResult = {
    summary: {
      totalSekolah: listSekolah.length,
      totalSekolahSD: rekapJenjang.SD.jmlSekolah,
      totalSekolahSMP: rekapJenjang.SMP.jmlSekolah,
      totalPTK: allPTK.length,
      totalGuru: rekapJenjang.TOTAL.guru,
      totalKS: rekapJenjang.TOTAL.ks,
      totalTendik: rekapJenjang.TOTAL.tendik,
      totalPNS: rekapJenjang.TOTAL.pns,
      totalPPPK: rekapJenjang.TOTAL.pppk,
      totalPW: rekapJenjang.TOTAL.pw,
      totalNonASN: rekapJenjang.TOTAL.nonAsn,
      persenASN: allPTK.length ? Math.round(((rekapJenjang.TOTAL.pns + rekapJenjang.TOTAL.pppk + rekapJenjang.TOTAL.pw) / allPTK.length) * 100) : 0
    },
    kecamatanList: Array.from(kecamatanSet).sort(),
    rekapKecamatan: Object.values(rekapKecamatan).sort((a, b) => a.kecamatan.localeCompare(b.kecamatan)),
    rekapJenjang: [rekapJenjang.SD, rekapJenjang.SMP, rekapJenjang.TOTAL],
    rekapSekolah: listSekolah.sort((a, b) => a.namaSekolah.localeCompare(b.namaSekolah)),
    
    // Data Khusus Analisis Kebutuhan Guru SD
    kebutuhanSD: {
      perSekolah: rekapKebutuhanSD_Sekolah.sort((a, b) => a.namaSekolah.localeCompare(b.namaSekolah)),
      perKecamatan: Object.values(rekapKebutuhanSD_Kecamatan).sort((a, b) => a.kecamatan.localeCompare(b.kecamatan))
    },
    lastUpdate: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd MMM yyyy HH:mm:ss')
  };

  try {
    cache.put(CACHE_KEY, JSON.stringify(finalResult), 900);
  } catch (err) {
    Logger.log("Cache error: " + err.message);
  }

  return finalResult;
}

/**
 * Helper membaca sheet PTK (Data / Data2)
 */
function readPTKSheet(ss, sheetName, defaultJenjang) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  
  const header = values[0].map(h => String(h).trim().toLowerCase());
  
  let npsnIdx = header.indexOf('npsn');
  if (npsnIdx === -1) npsnIdx = 2;
  
  let namaIdx = header.indexOf('nama');
  if (namaIdx === -1) namaIdx = 3;
  
  let statusIdx = header.indexOf('status');
  if (statusIdx === -1) statusIdx = 10;
  
  let tugasIdx = header.indexOf('tugas');
  if (tugasIdx === -1) tugasIdx = 12;
  
  let kecIdx = header.indexOf('kecamatan');
  if (kecIdx === -1) kecIdx = 1;
  
  let unitKerjaIdx = header.indexOf('unit_kerja');
  if (unitKerjaIdx === -1) unitKerjaIdx = header.indexOf('unit kerja');
  if (unitKerjaIdx === -1) unitKerjaIdx = 11;
  
  const ptkList = [];
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const nama = String(row[namaIdx] || '').trim();
    if (!nama) continue;
    
    const npsn = String(row[npsnIdx] || '').trim();
    const rawStatus = row[statusIdx];
    const rawTugas = row[tugasIdx];
    const rawKec = row[kecIdx];
    const rawUnit = row[unitKerjaIdx];
    
    ptkList.push({
      nama: nama,
      npsn: npsn,
      kecamatan: rawKec ? String(rawKec).trim() : '',
      unitKerja: rawUnit ? String(rawUnit).trim() : '',
      statusRaw: rawStatus,
      statusNorm: normalizeStatusKepegawaian(rawStatus),
      tugasRaw: rawTugas,
      jenisNorm: normalizeJenisPTK(rawTugas),
      jenjang: defaultJenjang
    });
  }
  
  return ptkList;
}

/**
 * Mengambil detail nama-nama PTK pada sekolah tertentu
 */
function getPTKDetailSekolah(npsn, namaSekolah) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const ptkSD = readPTKSheet(ss, 'Data', 'SD');
  const ptkSMP = readPTKSheet(ss, 'Data2', 'SMP');
  const allPTK = ptkSD.concat(ptkSMP);
  
  const targetNpsn = String(npsn || '').trim();
  const targetName = String(namaSekolah || '').trim().toUpperCase();
  
  const filtered = allPTK.filter(item => {
    if (targetNpsn && targetNpsn !== '-' && item.npsn === targetNpsn) return true;
    if (targetName && item.unitKerja && item.unitKerja.toUpperCase() === targetName) return true;
    return false;
  });
  
  return {
    sekolah: namaSekolah || targetNpsn,
    npsn: targetNpsn,
    total: filtered.length,
    pegawai: filtered
  };
}
