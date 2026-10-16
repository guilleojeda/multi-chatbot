export type GreetingProps = {
  label: string;
};

export function Greeting({ label }: GreetingProps) {
  return <main className="fixture-greeting">{label}</main>;
}
