`timescale 1ns/1ps
module counter_tb;
  reg clk = 0;
  reg rst_n = 0;
  wire [7:0] count;

  counter #(.WIDTH(8)) dut (
    .clk(clk),
    .rst_n(rst_n),
    .count(count)
  );

  always #5 clk = ~clk;

  initial begin
    rst_n = 0;
    #12 rst_n = 1;

    repeat (20) @(posedge clk);

    if (count !== 8'd19)
      $display("ERROR: expected count=19 got count=%0d", count);
    else
      $display("PASS: counter reached expected value (%0d)", count);

    $display("Simulation finished at time %0t", $time);
    $finish;
  end
endmodule
