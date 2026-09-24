// The consent library (C1): ready-made consents by procedure that an office installs and then edits to its own
// wording. They are starting points only — every one is marked "template — review with your attorney"
// (form_templates.legal_review) until the office has done so. English and Spanish wording have the same fields
// (same keys), so a signed form records which language the patient read.
//
// Placeholders filled in from the treatment when the consent is attached (consents.js consentContext):
//   {patient} {procedures} {procedure_list} {teeth} {provider} {fees} {practice} {date}

const SIGN_EN = [
  { type: 'checkbox', label: 'I have read this form (or had it read to me), my questions have been answered, and I understand the risks, benefits and alternatives.', required: true },
  { type: 'signature', label: 'Signature', required: true },
];
const SIGN_ES = [
  { type: 'checkbox', label: 'He leído este formulario (o me lo han leído), me han contestado mis preguntas y entiendo los riesgos, beneficios y alternativas.', required: true },
  { type: 'signature', label: 'Firma', required: true },
];
const PLAN_EN = { type: 'paragraph', text: 'Patient: {patient}. Planned treatment: {procedure_list}. Teeth: {teeth}. Dentist: {provider}. Estimated fee: {fees}.' };
const PLAN_ES = { type: 'paragraph', text: 'Paciente: {patient}. Tratamiento planeado: {procedure_list}. Dientes: {teeth}. Dentista: {provider}. Costo estimado: {fees}.' };
const para = (text) => ({ type: 'paragraph', text });
const heading = (label) => ({ type: 'heading', label });

export const CONSENT_LIBRARY = [
  {
    key: 'extraction', name: 'Consent for tooth extraction', kind: 'consent', procedure_codes: 'D71, D72', procedure_categories: 'oral_surgery', education: ['extraction-aftercare'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Risks include, but are not limited to: swelling, bruising and pain; bleeding; dry socket; infection; injury to nearby teeth or fillings; numbness or tingling of the lip, chin, tongue or cheek, usually temporary but rarely permanent; an opening into the sinus with upper teeth; jaw fracture; and root tips that may be left in place when removing them would do more harm.'),
      heading('Alternatives'),
      para('Alternatives include no treatment (with the risk of pain, infection and spread of infection), root canal treatment where the tooth can be saved, or referral to a specialist.'),
      { type: 'yesno', label: 'Are you taking blood thinners or bisphosphonates (bone medicines)?', required: true },
      { type: 'checkbox', label: 'I consent to the extraction described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('Los riesgos incluyen, entre otros: hinchazón, moretones y dolor; sangrado; alveolo seco; infección; daño a dientes o empastes cercanos; adormecimiento u hormigueo del labio, mentón, lengua o mejilla, casi siempre temporal pero en raros casos permanente; una comunicación con el seno maxilar en dientes superiores; fractura de la mandíbula; y puntas de raíz que pueden dejarse cuando sacarlas haría más daño.'),
      heading('Alternativas'),
      para('Las alternativas incluyen no hacer tratamiento (con el riesgo de dolor, infección y que la infección se extienda), un tratamiento de conducto si el diente se puede salvar, o referirle a un especialista.'),
      { type: 'yesno', label: '¿Toma anticoagulantes o bifosfonatos (medicinas para los huesos)?', required: true },
      { type: 'checkbox', label: 'Doy mi consentimiento para la extracción descrita arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'root_canal', name: 'Consent for root canal treatment', kind: 'consent', procedure_codes: 'D31, D32, D33, D34', procedure_categories: 'endodontics', education: ['root-canal'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Root canal treatment has a high success rate but cannot be guaranteed. Risks include: an instrument separating in the canal; a perforation of the root; a flare-up of pain or swelling; the tooth cracking; and the need for retreatment, surgery or extraction.'),
      heading('Alternatives'),
      para('Alternatives include extraction (and replacing the tooth with an implant, bridge or partial denture), referral to a root canal specialist, or no treatment, which risks pain, abscess and losing the tooth.'),
      { type: 'checkbox', label: 'I understand the tooth needs a final restoration (usually a crown) soon after treatment, or it may break.', required: true },
      { type: 'checkbox', label: 'I consent to the root canal treatment described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('El tratamiento de conducto tiene un alto porcentaje de éxito, pero no se puede garantizar. Los riesgos incluyen: que un instrumento se rompa dentro del conducto; una perforación de la raíz; un brote de dolor o hinchazón; que el diente se fracture; y la necesidad de repetir el tratamiento, cirugía o extracción.'),
      heading('Alternativas'),
      para('Las alternativas incluyen la extracción (y reemplazar el diente con un implante, puente o parcial), referirle a un endodoncista, o no hacer tratamiento, con riesgo de dolor, absceso y pérdida del diente.'),
      { type: 'checkbox', label: 'Entiendo que el diente necesita una restauración final (casi siempre una corona) poco después del tratamiento, o se puede romper.', required: true },
      { type: 'checkbox', label: 'Doy mi consentimiento para el tratamiento de conducto descrito arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'crown_bridge', name: 'Consent for crowns and bridges', kind: 'consent', procedure_codes: 'D27, D62, D67', procedure_categories: 'prosthodontics', education: ['crowns', 'bridges'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Preparing a tooth can irritate the nerve; some teeth later need a root canal. Temporary crowns can come loose or break. The bite may need adjusting. Teeth may be sensitive for a time. Porcelain can chip, and the color of a crown will not change with whitening.'),
      heading('Alternatives'),
      para('Alternatives include a large filling or onlay, an implant or partial denture instead of a bridge, or no treatment, which risks the tooth breaking or teeth shifting into the space.'),
      { type: 'checkbox', label: 'I consent to the crown and/or bridge treatment described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('Preparar un diente puede irritar el nervio; algunos dientes luego necesitan un tratamiento de conducto. Las coronas temporales se pueden despegar o romper. Puede ser necesario ajustar la mordida. Los dientes pueden estar sensibles por un tiempo. La porcelana se puede astillar y el color de una corona no cambia con el blanqueamiento.'),
      heading('Alternativas'),
      para('Las alternativas incluyen un empaste grande o incrustación, un implante o parcial en lugar de un puente, o no hacer tratamiento, con riesgo de que el diente se rompa o los dientes se muevan hacia el espacio.'),
      { type: 'checkbox', label: 'Doy mi consentimiento para las coronas y/o el puente descritos arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'implant', name: 'Consent for dental implant surgery', kind: 'consent', procedure_codes: 'D60, D61', procedure_categories: 'implants', witness: 1, education: ['implants'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Risks include: pain, swelling and bruising; bleeding; infection; the implant not bonding to the bone and needing to be removed; injury to nerves causing numbness of the lip, chin or tongue, rarely permanent; sinus involvement with upper implants; the need for bone grafting; and gum recession showing metal. Smoking, diabetes and some medicines raise the risk of failure.'),
      heading('Alternatives'),
      para('Alternatives include a bridge, a removable partial or complete denture, or leaving the space, which may let teeth shift and bone shrink.'),
      { type: 'yesno', label: 'Do you smoke or vape?', required: true },
      { type: 'checkbox', label: 'I consent to the implant surgery described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('Los riesgos incluyen: dolor, hinchazón y moretones; sangrado; infección; que el implante no se una al hueso y haya que retirarlo; lesión de nervios con adormecimiento del labio, mentón o lengua, en raros casos permanente; afectación del seno maxilar con implantes superiores; la necesidad de injerto de hueso; y retracción de la encía que deje ver el metal. Fumar, la diabetes y algunas medicinas aumentan el riesgo de fracaso.'),
      heading('Alternativas'),
      para('Las alternativas incluyen un puente, una dentadura parcial o completa removible, o dejar el espacio, lo que puede hacer que los dientes se muevan y el hueso se reduzca.'),
      { type: 'yesno', label: '¿Fuma o usa cigarrillos electrónicos?', required: true },
      { type: 'checkbox', label: 'Doy mi consentimiento para la cirugía de implante descrita arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'perio_srp', name: 'Consent for scaling and root planing (gum treatment)', kind: 'consent', procedure_codes: 'D4341, D4342, D4346, D42', procedure_categories: 'periodontics', education: ['gum-disease'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('After a deep cleaning, gums may be sore and teeth sensitive to cold for a few weeks. As the gums heal and shrink, spaces between teeth may look larger. Infection is rare. Gum disease is controlled, not cured: without regular maintenance visits it can return, and more treatment or referral to a specialist may be needed.'),
      heading('Alternatives'),
      para('Alternatives include referral to a periodontist (gum specialist), gum surgery, or no treatment, which risks continued bone loss, loose teeth and tooth loss.'),
      { type: 'checkbox', label: 'I consent to the gum treatment described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('Después de una limpieza profunda, las encías pueden doler y los dientes estar sensibles al frío por unas semanas. Al sanar y encogerse las encías, los espacios entre los dientes pueden verse más grandes. La infección es rara. La enfermedad de las encías se controla, no se cura: sin visitas de mantenimiento regulares puede volver, y puede necesitar más tratamiento o un especialista.'),
      heading('Alternativas'),
      para('Las alternativas incluyen referirle a un periodoncista (especialista de encías), cirugía de encías, o no hacer tratamiento, con riesgo de seguir perdiendo hueso, dientes flojos y pérdida de dientes.'),
      { type: 'checkbox', label: 'Doy mi consentimiento para el tratamiento de encías descrito arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'sedation', name: 'Consent for sedation / nitrous oxide', kind: 'consent', procedure_codes: 'D9230, D9239, D9243, D9248', procedure_categories: '', witness: 1,
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Sedation may cause drowsiness, nausea, vomiting, dizziness and, rarely, breathing problems, changes in heart rate or an allergic reaction. After oral or IV sedation you must not drive, operate machinery or make important decisions for 24 hours, and a responsible adult must take you home.'),
      heading('Alternatives'),
      para('Alternatives include treatment with local anesthetic only, or referral for treatment under general anesthesia.'),
      { type: 'yesno', label: 'Have you had anything to eat or drink in the last 6 hours?', required: true },
      { type: 'text', label: 'Adult driving you home (name and phone)' },
      { type: 'checkbox', label: 'I consent to sedation as described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('La sedación puede causar somnolencia, náusea, vómito, mareo y, en raros casos, problemas para respirar, cambios en el ritmo del corazón o una reacción alérgica. Después de una sedación oral o intravenosa no debe manejar, usar maquinaria ni tomar decisiones importantes por 24 horas, y un adulto responsable debe llevarle a casa.'),
      heading('Alternativas'),
      para('Las alternativas incluyen el tratamiento solo con anestesia local, o referirle para tratamiento con anestesia general.'),
      { type: 'yesno', label: '¿Ha comido o tomado algo en las últimas 6 horas?', required: true },
      { type: 'text', label: 'Adulto que le llevará a casa (nombre y teléfono)' },
      { type: 'checkbox', label: 'Doy mi consentimiento para la sedación descrita arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'ortho', name: 'Consent for orthodontic treatment', kind: 'consent', procedure_codes: 'D80, D81, D86', procedure_categories: 'orthodontics', education: ['orthodontics'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Results depend on wearing appliances and aligners as directed and keeping appointments. Risks include: decay and white spots around brackets if teeth are not kept clean; gum inflammation; shortening of tooth roots; jaw joint soreness; treatment taking longer than estimated; and teeth moving back if retainers are not worn.'),
      heading('Alternatives'),
      para('Alternatives include no treatment, limited treatment of some teeth, other appliance types, or crowns/veneers to improve appearance.'),
      { type: 'checkbox', label: 'I understand retainers must be worn as directed after treatment.', required: true },
      { type: 'checkbox', label: 'I consent to the orthodontic treatment described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('Los resultados dependen de usar los aparatos y alineadores como se indica y de asistir a las citas. Los riesgos incluyen: caries y manchas blancas alrededor de los brackets si los dientes no se mantienen limpios; inflamación de las encías; acortamiento de las raíces; molestias en la articulación de la mandíbula; que el tratamiento tarde más de lo estimado; y que los dientes regresen si no se usan los retenedores.'),
      heading('Alternativas'),
      para('Las alternativas incluyen no hacer tratamiento, tratar solo algunos dientes, otros tipos de aparatos, o coronas/carillas para mejorar la apariencia.'),
      { type: 'checkbox', label: 'Entiendo que debo usar los retenedores como se indica después del tratamiento.', required: true },
      { type: 'checkbox', label: 'Doy mi consentimiento para el tratamiento de ortodoncia descrito arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'whitening', name: 'Consent for teeth whitening', kind: 'consent', procedure_codes: 'D9972, D9975', procedure_categories: '', education: ['whitening'],
    fields: [
      PLAN_EN,
      heading('Risks'),
      para('Tooth sensitivity and gum irritation are common and usually go away within days. Results vary and are not permanent. Crowns, veneers and fillings do not whiten and may need replacing to match.'),
      heading('Alternatives'),
      para('Alternatives include no treatment, whitening toothpaste, veneers or crowns.'),
      { type: 'yesno', label: 'Are you pregnant or nursing?', required: true },
      { type: 'checkbox', label: 'I consent to teeth whitening as described above.', required: true },
      ...SIGN_EN,
    ],
    fields_es: [
      PLAN_ES,
      heading('Riesgos'),
      para('La sensibilidad dental y la irritación de las encías son comunes y casi siempre desaparecen en unos días. Los resultados varían y no son permanentes. Las coronas, carillas y empastes no se blanquean y puede ser necesario reemplazarlos para que combinen.'),
      heading('Alternativas'),
      para('Las alternativas incluyen no hacer tratamiento, pasta blanqueadora, carillas o coronas.'),
      { type: 'yesno', label: '¿Está embarazada o amamantando?', required: true },
      { type: 'checkbox', label: 'Doy mi consentimiento para el blanqueamiento descrito arriba.', required: true },
      ...SIGN_ES,
    ],
  },
  {
    key: 'refusal', name: 'Informed refusal of recommended treatment', kind: 'consent', procedure_codes: '', procedure_categories: '',
    fields: [
      para('Patient: {patient}. Recommended treatment: {procedure_list}. Teeth: {teeth}. Dentist: {provider}.'),
      para('The dentist has explained why this treatment is recommended, and the risks of not having it, which may include: worsening decay and pain; infection or abscess, which can spread; tooth loss; bone loss; and more complex and costly treatment later.'),
      { type: 'textarea', label: 'Reason for declining (optional)' },
      { type: 'checkbox', label: 'I understand the risks and I choose not to have the recommended treatment at this time. I may change my mind and ask for it later.', required: true },
      { type: 'signature', label: 'Signature', required: true },
    ],
    fields_es: [
      para('Paciente: {patient}. Tratamiento recomendado: {procedure_list}. Dientes: {teeth}. Dentista: {provider}.'),
      para('El dentista me ha explicado por qué se recomienda este tratamiento y los riesgos de no hacerlo, que pueden incluir: más caries y dolor; infección o absceso, que se puede extender; pérdida del diente; pérdida de hueso; y un tratamiento más complicado y costoso más adelante.'),
      { type: 'textarea', label: 'Motivo para rechazar (opcional)' },
      { type: 'checkbox', label: 'Entiendo los riesgos y decido no hacer el tratamiento recomendado por ahora. Puedo cambiar de opinión y pedirlo más adelante.', required: true },
      { type: 'signature', label: 'Firma', required: true },
    ],
  },
  {
    key: 'financial', name: 'Financial policy', kind: 'policy', procedure_codes: '', procedure_categories: '', renew_months: 12, auto_send: 1, due_rule: 'yearly',
    fields: [
      para('Payment is due when services are provided. We file dental insurance as a courtesy; insurance benefits are an estimate, and you are responsible for any amount insurance does not pay. Balances over 60 days may be sent to collections. Appointments missed without 24 hours’ notice may be charged a fee.'),
      { type: 'initials', label: 'I understand my insurance estimate is not a guarantee of payment.', required: true },
      { type: 'initials', label: 'I understand the missed-appointment policy.', required: true },
      { type: 'signature', label: 'Signature', required: true },
    ],
    fields_es: [
      para('El pago se debe al momento del servicio. Enviamos la reclamación al seguro dental como cortesía; los beneficios del seguro son un estimado y usted es responsable de lo que el seguro no pague. Los saldos de más de 60 días pueden enviarse a cobranza. Las citas perdidas sin 24 horas de aviso pueden tener un cargo.'),
      { type: 'initials', label: 'Entiendo que el estimado del seguro no es una garantía de pago.', required: true },
      { type: 'initials', label: 'Entiendo la política de citas perdidas.', required: true },
      { type: 'signature', label: 'Firma', required: true },
    ],
  },
];

export const LEGAL_NOTE = 'Template — review with your attorney before using it with patients.';
export const libraryItem = (key) => CONSENT_LIBRARY.find((x) => x.key === key) || null;
