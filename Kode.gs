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
 * Helper parsing tanggal TMT Non ASN (Kolom P)
 * Target cut-off: 3 Agustus 2023
 * Mengembalikan 'OLD' jika < 3-8-2023, 'NEW' jika >= 3-8-2023 (atau > 3-8-2023)
 */
function classifyTmtNonAsn(rawTmt) {
  if (!rawTmt) return 'NEW'; // default jika tidak ada tanggal
  
  let tmtDate = null;
  if (rawTmt instanceof Date) {
    tmtDate = rawTmt;
  } else {
    const s = String(rawTmt).trim();
    if (!s) return 'NEW';
    // Coba format DD/MM/YYYY atau DD-MM-YYYY
    const parts = s.split(/[\/\-\.]/);
    if (parts.length === 3) {
      const p0 = parseInt(parts[0], 10);
      const p1 = parseInt(parts[1], 10);
      const p2 = parseInt(parts[2], 10);
      if (p2 > 1000) {
        // format DD-MM-YYYY
        tmtDate = new Date(p2, p1 - 1, p0);
      } else if (p0 > 1000) {
        // format YYYY-MM-DD
        tmtDate = new Date(p0, p1 - 1, p2);
      }
    }
    if (!tmtDate || isNaN(tmtDate.getTime())) {
      const parsed = Date.parse(s);
      if (!isNaN(parsed)) tmtDate = new Date(parsed);
    }
  }

  if (!tmtDate || isNaN(tmtDate.getTime())) return 'NEW';

  // Batas cut-off: 3 Agustus 2023 (bulan Agustus = index 7)
  const cutOff = new Date(2023, 7, 3); // 3 Agustus 2023 00:00:00
  if (tmtDate.getTime() < cutOff.getTime()) {
    return 'OLD'; // < 3-8-2023
  } else {
    return 'NEW'; // > 3-8-2023
  }
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
      nonAsnOldCount: 0,
      nonAsnNewCount: 0,

      // Komposisi Khusus Guru SD (Kebutuhan & Ketersediaan)
      formasiSD: {
        KS: { butuh: (jenjang === 'SD' ? 1 : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        GURU_KELAS: { butuh: (jenjang === 'SD' ? rombel : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        GURU_PAI: { butuh: (jenjang === 'SD' ? hitungKebutuhanMapelSD(rombel) : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        GURU_PJOK: { butuh: (jenjang === 'SD' ? hitungKebutuhanMapelSD(rombel) : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        GURU_KRISTEN: { butuh: (jenjang === 'SD' ? butuhKristen : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        GURU_KATOLIK: { butuh: (jenjang === 'SD' ? butuhKatolik : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 }
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
        nonAsnOldCount: 0,
        nonAsnNewCount: 0,
        formasiSD: {
          KS: { butuh: (ptk.jenjang === 'SD' ? 1 : 0), pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
          GURU_KELAS: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
          GURU_PAI: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
          GURU_PJOK: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
          GURU_KRISTEN: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
          GURU_KATOLIK: { butuh: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 }
        }
      };
    }
    
    const sch = schoolMaster[schKey];
    sch.ptkCount++;
    
    // Status kepegawaian
    if (ptk.statusNorm === 'PNS') {
      sch.pnsCount++;
    } else if (ptk.statusNorm === 'PPPK') {
      sch.pppkCount++;
    } else if (ptk.statusNorm === 'PW') {
      sch.pwCount++;
    } else {
      sch.nonAsnCount++;
      if (ptk.tmtCategory === 'OLD') {
        sch.nonAsnOldCount++;
      } else {
        sch.nonAsnNewCount++;
      }
    }
    
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
        if (ptk.statusNorm === 'PNS') {
          targetFormasi.pns++;
        } else if (ptk.statusNorm === 'PPPK') {
          targetFormasi.pppk++;
        } else if (ptk.statusNorm === 'PW') {
          targetFormasi.pw++;
        } else {
          targetFormasi.nonAsn++;
          if (ptk.tmtCategory === 'OLD') {
            targetFormasi.nonAsnOld++;
          } else {
            targetFormasi.nonAsnNew++;
          }
        }
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
    const totalNonAsnOld = f.KS.nonAsnOld + f.GURU_KELAS.nonAsnOld + f.GURU_PAI.nonAsnOld + f.GURU_PJOK.nonAsnOld + f.GURU_KRISTEN.nonAsnOld + f.GURU_KATOLIK.nonAsnOld;
    const totalNonAsnNew = f.KS.nonAsnNew + f.GURU_KELAS.nonAsnNew + f.GURU_PAI.nonAsnNew + f.GURU_PJOK.nonAsnNew + f.GURU_KRISTEN.nonAsnNew + f.GURU_KATOLIK.nonAsnNew;

    // Hitung selisih per formasi
    const calcSelisih = (item) => (item.pns + item.pppk + item.pw) - item.butuh;

    const rowSekolah = {
      npsn: sd.npsn,
      namaSekolah: sd.namaSekolah,
      kecamatan: sd.kecamatan,
      rombel: sd.rombel,
      murid: sd.murid || 0,
      
      // Rincian per formasi
      ks: { butuh: f.KS.butuh, pns: f.KS.pns, pppk: f.KS.pppk, pw: f.KS.pw, selisih: calcSelisih(f.KS), nonAsn: f.KS.nonAsn, nonAsnOld: f.KS.nonAsnOld, nonAsnNew: f.KS.nonAsnNew },
      guruKelas: { butuh: f.GURU_KELAS.butuh, pns: f.GURU_KELAS.pns, pppk: f.GURU_KELAS.pppk, pw: f.GURU_KELAS.pw, selisih: calcSelisih(f.GURU_KELAS), nonAsn: f.GURU_KELAS.nonAsn, nonAsnOld: f.GURU_KELAS.nonAsnOld, nonAsnNew: f.GURU_KELAS.nonAsnNew },
      guruPai: { butuh: f.GURU_PAI.butuh, pns: f.GURU_PAI.pns, pppk: f.GURU_PAI.pppk, pw: f.GURU_PAI.pw, selisih: calcSelisih(f.GURU_PAI), nonAsn: f.GURU_PAI.nonAsn, nonAsnOld: f.GURU_PAI.nonAsnOld, nonAsnNew: f.GURU_PAI.nonAsnNew },
      guruPjok: { butuh: f.GURU_PJOK.butuh, pns: f.GURU_PJOK.pns, pppk: f.GURU_PJOK.pppk, pw: f.GURU_PJOK.pw, selisih: calcSelisih(f.GURU_PJOK), nonAsn: f.GURU_PJOK.nonAsn, nonAsnOld: f.GURU_PJOK.nonAsnOld, nonAsnNew: f.GURU_PJOK.nonAsnNew },
      guruKristen: { butuh: f.GURU_KRISTEN.butuh, pns: f.GURU_KRISTEN.pns, pppk: f.GURU_KRISTEN.pppk, pw: f.GURU_KRISTEN.pw, selisih: calcSelisih(f.GURU_KRISTEN), nonAsn: f.GURU_KRISTEN.nonAsn, nonAsnOld: f.GURU_KRISTEN.nonAsnOld, nonAsnNew: f.GURU_KRISTEN.nonAsnNew },
      guruKatolik: { butuh: f.GURU_KATOLIK.butuh, pns: f.GURU_KATOLIK.pns, pppk: f.GURU_KATOLIK.pppk, pw: f.GURU_KATOLIK.pw, selisih: calcSelisih(f.GURU_KATOLIK), nonAsn: f.GURU_KATOLIK.nonAsn, nonAsnOld: f.GURU_KATOLIK.nonAsnOld, nonAsnNew: f.GURU_KATOLIK.nonAsnNew },
      
      // Total Sekolah
      total: {
        butuh: totalButuh,
        pns: totalPNS,
        pppk: totalPPPK,
        pw: totalPW,
        pengurang: totalPengurang,
        selisih: totalSelisih,
        nonAsn: totalNonASN,
        nonAsnOld: totalNonAsnOld,
        nonAsnNew: totalNonAsnNew
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
        ks: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        guruKelas: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        guruPai: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        guruPjok: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        guruKristen: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        guruKatolik: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
        total: { butuh: 0, pns: 0, pppk: 0, pw: 0, selisih: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 }
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
      target.nonAsnOld += (src.nonAsnOld || 0);
      target.nonAsnNew += (src.nonAsnNew || 0);
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
        nonAsn: 0,
        nonAsnOld: 0,
        nonAsnNew: 0
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
    rk.nonAsnOld += (sch.nonAsnOldCount || 0);
    rk.nonAsnNew += (sch.nonAsnNewCount || 0);
  });

  const rekapJenjang = {
    SD: { jenjang: 'SD', jmlSekolah: listSD.length, totalPTK: ptkSDList.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
    SMP: { jenjang: 'SMP', jmlSekolah: listSekolah.filter(s => s.jenjang === 'SMP').length, totalPTK: ptkSMPList.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 },
    TOTAL: { jenjang: 'TOTAL (SD & SMP)', jmlSekolah: listSekolah.length, totalPTK: allPTK.length, guru: 0, ks: 0, tendik: 0, pns: 0, pppk: 0, pw: 0, nonAsn: 0, nonAsnOld: 0, nonAsnNew: 0 }
  };

  allPTK.forEach(ptk => {
    const target = rekapJenjang[ptk.jenjang] || rekapJenjang.SD;
    const tot = rekapJenjang.TOTAL;
    
    if (ptk.statusNorm === 'PNS') { target.pns++; tot.pns++; }
    else if (ptk.statusNorm === 'PPPK') { target.pppk++; tot.pppk++; }
    else if (ptk.statusNorm === 'PW') { target.pw++; tot.pw++; }
    else {
      target.nonAsn++; tot.nonAsn++;
      if (ptk.tmtCategory === 'OLD') {
        target.nonAsnOld++; tot.nonAsnOld++;
      } else {
        target.nonAsnNew++; tot.nonAsnNew++;
      }
    }
    
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
      totalNonAsnOld: rekapJenjang.TOTAL.nonAsnOld,
      totalNonAsnNew: rekapJenjang.TOTAL.nonAsnNew,
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
  
  const header = values[0].map(h => String(h || '').trim().toLowerCase());
  
  // Deteksi indeks kolom lebih fleksibel
  let npsnIdx = header.findIndex(h => h === 'npsn' || h.includes('npsn'));
  if (npsnIdx === -1) npsnIdx = 2; // Kolom C
  
  let namaIdx = header.findIndex(h => h === 'nama' || h.includes('nama ptk') || h.includes('nama pegawai') || h.includes('nama lengkap'));
  if (namaIdx === -1) namaIdx = header.findIndex(h => h.includes('nama'));
  if (namaIdx === -1) namaIdx = 3; // Kolom D
  
  let statusIdx = header.findIndex(h => h === 'status' || h.includes('status kepegawaian') || h.includes('kepegawaian'));
  if (statusIdx === -1) statusIdx = header.findIndex(h => h.includes('status'));
  if (statusIdx === -1) statusIdx = 10; // Kolom K
  
  let tugasIdx = header.findIndex(h => h === 'tugas' || h.includes('tugas tambahan') || h.includes('jabatan') || h.includes('jenis ptk'));
  if (tugasIdx === -1) tugasIdx = header.findIndex(h => h.includes('tugas'));
  if (tugasIdx === -1) tugasIdx = 12; // Kolom M
  
  let kecIdx = header.findIndex(h => h === 'kecamatan' || h.includes('kecamatan'));
  if (kecIdx === -1) kecIdx = 1; // Kolom B
  
  let unitKerjaIdx = header.findIndex(h => h === 'unit kerja' || h === 'unit_kerja' || h.includes('unit kerja') || h.includes('sekolah') || h.includes('tempat tugas'));
  if (unitKerjaIdx === -1) unitKerjaIdx = 11; // Kolom L
  
  // Kolom P adalah index 15 (0-based: A=0... P=15)
  let tmtIdx = header.findIndex(h => h.includes('tmt'));
  if (tmtIdx === -1) tmtIdx = 15; // Kolom P fallback
  
  const ptkList = [];
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const nama = String(row[namaIdx] || '').trim();
    if (!nama) continue;
    
    // Normalisasi string NPSN (hilangkan tanda petik/spasi/desimal jika terbaca float)
    let rawNpsn = String(row[npsnIdx] || '').trim();
    if (rawNpsn.includes('.')) {
      rawNpsn = rawNpsn.split('.')[0];
    }
    const cleanNpsn = rawNpsn.replace(/[^0-9]/g, '');
    const npsn = cleanNpsn || rawNpsn;

    const rawStatus = row[statusIdx];
    const rawTugas = row[tugasIdx];
    const rawKec = row[kecIdx];
    const rawUnit = row[unitKerjaIdx];
    const rawTmt = row[tmtIdx];
    
    const statusNorm = normalizeStatusKepegawaian(rawStatus);
    const tmtCategory = (statusNorm === 'Non-ASN') ? classifyTmtNonAsn(rawTmt) : null;
    
    let tmtFormatted = '';
    if (rawTmt) {
      if (rawTmt instanceof Date && !isNaN(rawTmt.getTime())) {
        tmtFormatted = Utilities.formatDate(rawTmt, 'Asia/Jakarta', 'dd-MM-yyyy');
      } else {
        tmtFormatted = String(rawTmt).trim();
      }
    }

    ptkList.push({
      nama: nama,
      npsn: npsn,
      kecamatan: rawKec ? String(rawKec).trim() : '',
      unitKerja: rawUnit ? String(rawUnit).trim() : '',
      statusRaw: rawStatus,
      statusNorm: statusNorm,
      tmtRaw: rawTmt,
      tmtCategory: tmtCategory, // 'OLD' (< 3-8-2023) atau 'NEW' (> 3-8-2023)
      tmtFormatted: tmtFormatted,
      tugasRaw: rawTugas,
      jenisNorm: normalizeJenisPTK(rawTugas),
      jenjang: defaultJenjang
    });
  }
  
  return ptkList;
}

/**
 * Helper membersihkan nama sekolah untuk pencocokan toleran
 */
function cleanSchoolNameForMatch(name) {
  if (!name) return '';
  return String(name)
    .toUpperCase()
    .replace(/^SD\s+NEGERI\b/, 'SDN')
    .replace(/^SMP\s+NEGERI\b/, 'SMPN')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

/**
 * Mengambil detail nama-nama PTK pada sekolah tertentu
 */
function getPTKDetailSekolah(npsn, namaSekolah) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const ptkSD = readPTKSheet(ss, 'Data', 'SD');
  const ptkSMP = readPTKSheet(ss, 'Data2', 'SMP');
  const allPTK = ptkSD.concat(ptkSMP);
  
  let targetNpsnRaw = String(npsn || '').trim();
  if (targetNpsnRaw.includes('.')) targetNpsnRaw = targetNpsnRaw.split('.')[0];
  const targetNpsnDigits = targetNpsnRaw.replace(/[^0-9]/g, '');

  const targetName = String(namaSekolah || '').trim().toUpperCase();
  const cleanTargetName = cleanSchoolNameForMatch(targetName);
  
  const filtered = allPTK.filter(item => {
    const itemNpsnDigits = String(item.npsn || '').replace(/[^0-9]/g, '');
    
    // 1. Cocokkan berdasarkan digit NPSN jika valid (misal 8 digit)
    if (targetNpsnDigits && targetNpsnDigits.length >= 6 && itemNpsnDigits) {
      if (itemNpsnDigits === targetNpsnDigits) return true;
    }
    
    // 2. Cocokkan string NPSN mentah jika bukan '-'
    if (targetNpsnRaw && targetNpsnRaw !== '-' && item.npsn) {
      if (item.npsn === targetNpsnRaw) return true;
    }
    
    // 3. Cocokkan berdasarkan unitKerja persis
    if (targetName && item.unitKerja) {
      const itemUnitUpper = item.unitKerja.toUpperCase().trim();
      if (itemUnitUpper === targetName) return true;
      
      // 4. Cocokkan nama sekolah yang sudah dinormalisasi (SDN GRABAG 1 vs SD NEGERI GRABAG 1)
      if (cleanTargetName && cleanSchoolNameForMatch(itemUnitUpper) === cleanTargetName) {
        return true;
      }
    }
    
    return false;
  });
  
  return {
    sekolah: namaSekolah || targetNpsnRaw,
    npsn: targetNpsnRaw,
    total: filtered.length,
    pegawai: filtered
  };
}
