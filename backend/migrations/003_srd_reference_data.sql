-- SRD Monsters
CREATE TABLE srd_monsters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size TEXT NOT NULL,
  type TEXT NOT NULL,
  alignment TEXT,
  ac INTEGER NOT NULL,
  ac_type TEXT,
  hp INTEGER NOT NULL,
  hit_dice TEXT NOT NULL,
  speed JSONB NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  saving_throws JSONB,
  skills JSONB,
  damage_resistances TEXT[],
  damage_immunities TEXT[],
  damage_vulnerabilities TEXT[],
  condition_immunities TEXT[],
  senses JSONB,
  languages TEXT[],
  cr TEXT NOT NULL,
  xp INTEGER NOT NULL,
  special_abilities JSONB,
  actions JSONB,
  legendary_actions JSONB,
  reactions JSONB,
  data JSONB
);

-- SRD Spells
CREATE TABLE srd_spells (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL,
  school TEXT NOT NULL,
  casting_time TEXT NOT NULL,
  range TEXT NOT NULL,
  components TEXT NOT NULL,
  duration TEXT NOT NULL,
  concentration BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL,
  higher_levels TEXT,
  damage JSONB,
  area_of_effect JSONB,
  save JSONB,
  classes TEXT[],
  data JSONB
);

-- SRD Conditions
CREATE TABLE srd_conditions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mechanical_effects JSONB
);
