"use client";

import { useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function HubTabs({
  basePath,
  activeTab,
  tabs,
}: {
  basePath: string;
  activeTab: string;
  tabs: { value: string; label: string }[];
}) {
  const router = useRouter();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (!value) return;
        router.push(`${basePath}?tab=${value}`);
      }}
    >
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
