/**
 * DASHBOARD KEADAAN PTK (PENDIDIK & TENAGA KEPENDIDIKAN)
 * Server-side Google Apps Script
 */

const SPREADSHEET_ID = '1vOGuQ0McBu1ZbGC5XfITaIa5Rdk5o22KG_3MvvVLnVA';

/**
 * Endpoint Web App (HTML Service)
 */
function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('Dashboard Keadaan PTK - SD & SMP')
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
 */
function normalizeStatusKepegawaian(rawStatus) {
  if (!rawStatus) return 'Non-ASN';
  const val = String(rawStatus).trim().toUpperCase();
  if (val.includes('PNS') && !val.includes('PPPK') && !val.includes('NON')) {
    return 'PNS';
  } else if (val.includes('PPPK') || val.includes('P3K')) {
    return 'PPPK';
  } else {
    return 'Non-ASN';
  }
}

/**
 * Normalisasi Jenis PTK (Kolom M / tugas)
 * Guru (Pendidik), Kepala Sekolah, Tendik
 */
function normalizeJenisPTK(rawTugas) {
  if (!rawTugas) return 'Tendik';
  const val = String(rawTugas).trim().toLowerCase();
  
  if (val.includes('kepala sekolah') || val.includes('ks') || val === 'kasek') {
    return 'Kepala Sekolah';
  }
  
  // Deteksi Guru
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
  
  // Default lainnya masuk Tenaga Kependidikan (Tendik)
  return 'Tendik';
}

/**
 * Mengambil dan mengagregasi seluruh data rekapitulasi PTK
 * @param {boolean} forceRefresh - Bypass cache jika true
 */
function getDashboardData(forceRefresh) {
  const cache = CacheService.getScriptCache();
  const CACHE_KEY = 'REKAP_PTK_SUMMARY_DATA_V1';
  
  if (!forceRefresh) {
    const cached = cache.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // Abaikan dan ambil ulang jika JSON parse gagal
      }
    }
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // 1. Ambil Master DataUnit
  const sheetUnit = ss.getSheetByName('DataUnit');
  if (!sheetUnit) throw new Error("Sheet 'DataUnit' tidak ditemukan!");
  
  const unitValues = sheetUnit.getDataRange().getValues();
  if (unitValues.length < 2) throw new Error("Sheet 'DataUnit' kosong!");
  
  const unitHeader = unitValues[0].map(h => String(h).trim().toLowerCase());
  
  // Cari index kolom DataUnit
  let npsnColIdx = unitHeader.indexOf('npsn');
  if (npsnColIdx === -1) npsnColIdx = 39; // fallback kolom AN
  
  let unitKerjaColIdx = unitHeader.indexOf('unit kerja');
  if (unitKerjaColIdx === -1) unitKerjaColIdx = 0; // Kolom A
  
  let kecColIdx = unitHeader.indexOf('kecamatan');
  if (kecColIdx === -1) kecColIdx = 1; // Kolom B
  
  // Map master sekolah berdasarkan NPSN
  const schoolMaster = {}; // npsn -> { npsn, namaSekolah, kecamatan, jenjang, status }
  const kecamatanSet = new Set();
  
  for (let i = 1; i < unitValues.length; i++) {
    const row = unitValues[i];
    const npsn = String(row[npsnColIdx] || '').trim();
    const namaSekolah = String(row[unitKerjaColIdx] || '').trim();
    let kecamatan = String(row[kecColIdx] || '').trim();
    
    if (!npsn && !namaSekolah) continue;
    
    // Standarisasi Kecamatan (Title Case)
    if (kecamatan) {
      kecamatan = kecamatan.toUpperCase();
      kecamatanSet.add(kecamatan);
    } else {
      kecamatan = 'LAINNYA';
    }
    
    // Deteksi jenjang dari nama sekolah
    let jenjang = 'SD';
    const upperName = namaSekolah.toUpperCase();
    if (upperName.includes('SMP')) {
      jenjang = 'SMP';
    } else if (upperName.includes('TK') || upperName.includes('PAUD')) {
      jenjang = 'PAUD/TK';
    }
    
    const key = npsn || ('NAME_' + namaSekolah.toUpperCase());
    schoolMaster[key] = {
      npsn: npsn || '-',
      namaSekolah: namaSekolah,
      kecamatan: kecamatan,
      jenjang: jenjang,
      ptkCount: 0,
      guruCount: 0,
      ksCount: 0,
      tendikCount: 0,
      pnsCount: 0,
      pppkCount: 0,
      nonAsnCount: 0,
      // Kombinasi Guru
      guruPns: 0,
      guruPppk: 0,
      guruNonAsn: 0,
      // Kombinasi KS
      ksPns: 0,
      ksPppk: 0,
      ksNonAsn: 0,
      // Kombinasi Tendik
      tendikPns: 0,
      tendikPppk: 0,
      tendikNonAsn: 0
    };
  }

  // 2. Baca Data PTK SD ('Data') & SMP ('Data2')
  const ptkSDList = readPTKSheet(ss, 'Data', 'SD');
  const ptkSMPList = readPTKSheet(ss, 'Data2', 'SMP');
  
  // Gabungkan seluruh PTK
  const allPTK = ptkSDList.concat(ptkSMPList);

  // 3. Agregasi ke Sekolah Master & Catat detail per sekolah
  const schoolDetails = {}; // npsn/key -> list pegawai ringkas
  
  allPTK.forEach(ptk => {
    let schKey = ptk.npsn;
    if (!schKey || !schoolMaster[schKey]) {
      // Coba cocokan berdasarkan nama sekolah
      const altKey = 'NAME_' + (ptk.unitKerja || '').toUpperCase();
      if (schoolMaster[altKey]) {
        schKey = altKey;
      }
    }
    
    // Jika sekolah belum ada di master DataUnit, buat entri dinamis
    if (!schoolMaster[schKey]) {
      const fallbackKec = (ptk.kecamatan || 'LAINNYA').toUpperCase();
      kecamatanSet.add(fallbackKec);
      schoolMaster[schKey] = {
        npsn: ptk.npsn || '-',
        namaSekolah: ptk.unitKerja || ('Sekolah ' + ptk.npsn),
        kecamatan: fallbackKec,
        jenjang: ptk.jenjang,
        ptkCount: 0,
        guruCount: 0,
        ksCount: 0,
        tendikCount: 0,
        pnsCount: 0,
        pppkCount: 0,
        nonAsnCount: 0,
        guruPns: 0,
        guruPppk: 0,
        guruNonAsn: 0,
        ksPns: 0,
        ksPppk: 0,
        ksNonAsn: 0,
        tendikPns: 0,
        tendikPppk: 0,
        tendikNonAsn: 0
      };
    }
    
    const sch = schoolMaster[schKey];
    sch.ptkCount++;
    
    // Status kepegawaian
    if (ptk.statusNorm === 'PNS') sch.pnsCount++;
    else if (ptk.statusNorm === 'PPPK') sch.pppkCount++;
    else sch.nonAsnCount++;
    
    // Peran / Tugas
    if (ptk.jenisNorm === 'Kepala Sekolah') {
      sch.ksCount++;
      if (ptk.statusNorm === 'PNS') sch.ksPns++;
      else if (ptk.statusNorm === 'PPPK') sch.ksPppk++;
      else sch.ksNonAsn++;
    } else if (ptk.jenisNorm === 'Guru') {
      sch.guruCount++;
      if (ptk.statusNorm === 'PNS') sch.guruPns++;
      else if (ptk.statusNorm === 'PPPK') sch.guruPppk++;
      else sch.guruNonAsn++;
    } else {
      sch.tendikCount++;
      if (ptk.statusNorm === 'PNS') sch.tendikPns++;
      else if (ptk.statusNorm === 'PPPK') sch.tendikPppk++;
      else sch.tendikNonAsn++;
    }
  });

  // 4. Bangun Rekapitulasi per Kecamatan
  const rekapKecamatan = {};
  const listSekolah = Object.values(schoolMaster);

  listSekolah.forEach(sch => {
    const kec = sch.kecamatan || 'LAINNYA';
    if (!rekapKecamatan[kec]) {
      rekapKecamatan[kec] = {
        kecamatan: kec,
        jmlSekolahSD: 0,
        jmlSekolahSMP: 0,
        totalSekolah: 0,
        totalPTK: 0,
        // Jenjang
        ptkSD: 0,
        ptkSMP: 0,
        // Jabatan
        guru: 0,
        ks: 0,
        tendik: 0,
        // Status
        pns: 0,
        pppk: 0,
        nonAsn: 0,
        // Rincian Guru
        guruPns: 0,
        guruPppk: 0,
        guruNonAsn: 0,
        // Rincian Tendik
        tendikPns: 0,
        tendikPppk: 0,
        tendikNonAsn: 0
      };
    }
    
    const rk = rekapKecamatan[kec];
    rk.totalSekolah++;
    if (sch.jenjang === 'SD') rk.jmlSekolahSD++;
    else if (sch.jenjang === 'SMP') rk.jmlSekolahSMP++;
    
    rk.totalPTK += sch.ptkCount;
    if (sch.jenjang === 'SD') rk.ptkSD += sch.ptkCount;
    else if (sch.jenjang === 'SMP') rk.ptkSMP += sch.ptkCount;
    
    rk.guru += sch.guruCount;
    rk.ks += sch.ksCount;
    rk.tendik += sch.tendikCount;
    
    rk.pns += sch.pnsCount;
    rk.pppk += sch.pppkCount;
    rk.nonAsn += sch.nonAsnCount;
    
    rk.guruPns += sch.guruPns;
    rk.guruPppk += sch.guruPppk;
    rk.guruNonAsn += sch.guruNonAsn;
    
    rk.tendikPns += sch.tendikPns;
    rk.tendikPppk += sch.tendikPppk;
    rk.tendikNonAsn += sch.tendikNonAsn;
  });

  // 5. Bangun Rekapitulasi per Jenjang
  const rekapJenjang = {
    SD: {
      jenjang: 'SD',
      jmlSekolah: listSekolah.filter(s => s.jenjang === 'SD').length,
      totalPTK: ptkSDList.length,
      guru: 0,
      ks: 0,
      tendik: 0,
      pns: 0,
      pppk: 0,
      nonAsn: 0,
      guruPns: 0,
      guruPppk: 0,
      guruNonAsn: 0,
      ksPns: 0,
      ksPppk: 0,
      ksNonAsn: 0,
      tendikPns: 0,
      tendikPppk: 0,
      tendikNonAsn: 0
    },
    SMP: {
      jenjang: 'SMP',
      jmlSekolah: listSekolah.filter(s => s.jenjang === 'SMP').length,
      totalPTK: ptkSMPList.length,
      guru: 0,
      ks: 0,
      tendik: 0,
      pns: 0,
      pppk: 0,
      nonAsn: 0,
      guruPns: 0,
      guruPppk: 0,
      guruNonAsn: 0,
      ksPns: 0,
      ksPppk: 0,
      ksNonAsn: 0,
      tendikPns: 0,
      tendikPppk: 0,
      tendikNonAsn: 0
    },
    TOTAL: {
      jenjang: 'TOTAL (SD & SMP)',
      jmlSekolah: listSekolah.length,
      totalPTK: allPTK.length,
      guru: 0,
      ks: 0,
      tendik: 0,
      pns: 0,
      pppk: 0,
      nonAsn: 0,
      guruPns: 0,
      guruPppk: 0,
      guruNonAsn: 0,
      ksPns: 0,
      ksPppk: 0,
      ksNonAsn: 0,
      tendikPns: 0,
      tendikPppk: 0,
      tendikNonAsn: 0
    }
  };

  allPTK.forEach(ptk => {
    const target = rekapJenjang[ptk.jenjang] || rekapJenjang.SD;
    const tot = rekapJenjang.TOTAL;
    
    // Status
    if (ptk.statusNorm === 'PNS') {
      target.pns++;
      tot.pns++;
    } else if (ptk.statusNorm === 'PPPK') {
      target.pppk++;
      tot.pppk++;
    } else {
      target.nonAsn++;
      tot.nonAsn++;
    }
    
    // Jabatan
    if (ptk.jenisNorm === 'Kepala Sekolah') {
      target.ks++;
      tot.ks++;
      if (ptk.statusNorm === 'PNS') { target.ksPns++; tot.ksPns++; }
      else if (ptk.statusNorm === 'PPPK') { target.ksPppk++; tot.ksPppk++; }
      else { target.ksNonAsn++; tot.ksNonAsn++; }
    } else if (ptk.jenisNorm === 'Guru') {
      target.guru++;
      tot.guru++;
      if (ptk.statusNorm === 'PNS') { target.guruPns++; tot.guruPns++; }
      else if (ptk.statusNorm === 'PPPK') { target.guruPppk++; tot.guruPppk++; }
      else { target.guruNonAsn++; tot.guruNonAsn++; }
    } else {
      target.tendik++;
      tot.tendik++;
      if (ptk.statusNorm === 'PNS') { target.tendikPns++; tot.tendikPns++; }
      else if (ptk.statusNorm === 'PPPK') { target.tendikPppk++; tot.tendikPppk++; }
      else { target.tendikNonAsn++; tot.tendikNonAsn++; }
    }
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
      totalNonASN: rekapJenjang.TOTAL.nonAsn,
      persenASN: allPTK.length ? Math.round(((rekapJenjang.TOTAL.pns + rekapJenjang.TOTAL.pppk) / allPTK.length) * 100) : 0
    },
    kecamatanList: Array.from(kecamatanSet).sort(),
    rekapKecamatan: Object.values(rekapKecamatan).sort((a, b) => a.kecamatan.localeCompare(b.kecamatan)),
    rekapJenjang: [rekapJenjang.SD, rekapJenjang.SMP, rekapJenjang.TOTAL],
    rekapSekolah: listSekolah.sort((a, b) => a.namaSekolah.localeCompare(b.namaSekolah)),
    lastUpdate: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd MMM yyyy HH:mm:ss')
  };

  // Simpan ke Cache selama 15 menit (900 detik)
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
  
  // Deteksi indeks kolom
  let npsnIdx = header.indexOf('npsn');
  if (npsnIdx === -1) npsnIdx = 2; // Default Kolom C
  
  let namaIdx = header.indexOf('nama');
  if (namaIdx === -1) namaIdx = 3; // Default Kolom D
  
  let statusIdx = header.indexOf('status');
  if (statusIdx === -1) statusIdx = 10; // Default Kolom K
  
  let tugasIdx = header.indexOf('tugas');
  if (tugasIdx === -1) tugasIdx = 12; // Default Kolom M
  
  let kecIdx = header.indexOf('kecamatan');
  if (kecIdx === -1) kecIdx = 1; // Default Kolom B
  
  let unitKerjaIdx = header.indexOf('unit_kerja');
  if (unitKerjaIdx === -1) unitKerjaIdx = header.indexOf('unit kerja');
  if (unitKerjaIdx === -1) unitKerjaIdx = 11; // Default Kolom L
  
  const ptkList = [];
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const nama = String(row[namaIdx] || '').trim();
    if (!nama) continue; // Lewati baris kosong
    
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
 * @param {string} npsn
 * @param {string} namaSekolah
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
