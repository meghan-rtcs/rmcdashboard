// Defaults for the owner-editable Team Performance program. These values are
// seeded into SQLite on first use; the database copy is what the application
// reads, so changing a value in Settings never requires a deploy.
export const DEFAULT_TEAM_SETTINGS = {
  quarterly_incentive: 1000,
  stretch_bonus: 1000,
  stretch_best_ratio: 0.75,
  tier_payouts: { good: 0.5, better: 0.75, best: 1 },
  bonus_eligible_property_group: "",
  vendor_exemption_field: "",
  discretionary_max_by_role: {
    "Senior Property Manager": 4000,
    "Maintenance Coordinator": 4000,
    "Maintenance Technician": 4000,
    "Bookkeeper": 4000,
  },
  discretionary_questions: [
    "Demonstrates dependable follow-through.",
    "Communicates clearly and promptly.",
    "Takes ownership of resident and owner outcomes.",
    "Works collaboratively across the team.",
    "Uses sound judgment and follows company processes.",
    "Maintains accurate, timely documentation.",
    "Contributes to a respectful, solutions-focused culture.",
  ],
};

export const REQUIRED_KPI_DEFAULTS = {
  pm_vacancy_days: { good: 30, better: 20, best: 10 },
  pm_owner_insurance: { good: 70, better: 80, best: 90 },
  pm_inspections: { good: 40, better: 50, best: 60 },
  mnt_wo_30days: { good: 80, better: 90, best: 95 },
  bk_delinquent_rent: { good: 10, better: 5, best: 2 },
};