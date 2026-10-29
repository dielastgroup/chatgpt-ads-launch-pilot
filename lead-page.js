import { LEAD_ENDPOINT } from './lead-config.js';
import { mountLeadForm } from './lead-intake.js';

mountLeadForm({ form: document.getElementById('lead'), status: document.getElementById('status'), endpoint: LEAD_ENDPOINT });
